// Package reset implements the Relay's destructive factory reset.
//
// Unlike a per-account purge, this erases the Relay's whole shared state:
// every account, device, storage node, file catalog, key envelope, session,
// tombstone, Redis key, and buffered shard. Clients and nodes must register
// and pair again afterwards.
package reset

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
)

// ConfirmPhrase is the exact text the operator must type to authorize a reset.
// Matched case-sensitively so a reflex "yes"/empty line cannot wipe the Relay.
const ConfirmPhrase = "purge everything"

// Options carries the escape hatches for the two guardrails an operator may have
// a genuine reason to bypass. Everything else is a hard refusal.
type Options struct {
	// Force skips the live-connection check for the operator who knows the
	// remaining connection is their own client and the Relay really is stopped.
	Force bool
}

// Run erases all Relay state:
//
//   - Postgres: drop and recreate the `public` schema. This removes every table,
//     including golang-migrate's `schema_migrations`, so the next boot rebuilds
//     the schema from the embedded migrations (a true factory state).
//   - Redis: flush the configured database index (presence, pending buffers,
//     fetch tokens, rate-limit counters).
//   - Buffer dir: remove and recreate the on-disk shard buffer.
//
// The caller is responsible for confirming the reset with the operator and for
// stopping the running Relay first. Both are enforced here rather than trusted:
// the buffer directory is validated before os.RemoveAll is pointed at it, and the
// schema drop refuses while another connection is still attached.
func Run(ctx context.Context, cfg *config.Config, opts Options) error {
	// Check the destructive path target first, so a bad BUFFER_DIR aborts with
	// the database and Redis untouched rather than after the schema is gone.
	if err := validateBufferDir(cfg.BufferDir); err != nil {
		return err
	}

	conn, err := pgx.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connecting to postgres: %w", err)
	}
	defer conn.Close(ctx) //nolint:errcheck

	if err := checkNoLiveConnections(ctx, conn, opts.Force); err != nil {
		return err
	}

	if _, err := conn.Exec(ctx, "DROP SCHEMA IF EXISTS public CASCADE"); err != nil {
		return fmt.Errorf("dropping schema: %w", err)
	}
	if _, err := conn.Exec(ctx, "CREATE SCHEMA public"); err != nil {
		return fmt.Errorf("recreating schema: %w", err)
	}

	redisClient, err := rdb.Open(ctx, cfg)
	if err != nil {
		return fmt.Errorf("connecting to redis: %w", err)
	}
	defer redisClient.Close() //nolint:errcheck
	if err := redisClient.FlushDB(ctx).Err(); err != nil {
		return fmt.Errorf("flushing redis: %w", err)
	}

	if err := os.RemoveAll(cfg.BufferDir); err != nil {
		return fmt.Errorf("clearing buffer directory: %w", err)
	}
	if err := os.MkdirAll(cfg.BufferDir, 0o755); err != nil {
		return fmt.Errorf("recreating buffer directory: %w", err)
	}
	return nil
}
