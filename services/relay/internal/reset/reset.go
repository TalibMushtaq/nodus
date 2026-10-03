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

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
)

// ConfirmPhrase is the exact text the operator must type to authorize a reset.
// Matched case-sensitively so a reflex "yes"/empty line cannot wipe the Relay.
const ConfirmPhrase = "purge everything"

// Options carries the escape hatches for the guardrail an operator may have a
// genuine reason to bypass. Everything else is a hard refusal.
type Options struct {
	// Force skips the running-relay check for the operator who knows the
	// process holding the database lock is not the one they mean to reset.
	Force bool
}

// Run erases all Relay state:
//
//   - SQLite: delete the database file and its -wal/-shm sidecars. The next boot
//     rebuilds the schema from the embedded baseline (a true factory state).
//   - Redis: flush the configured database index (presence, pending buffers,
//     fetch tokens, rate-limit counters).
//   - Buffer dir: remove and recreate the on-disk shard buffer.
//
// The caller is responsible for confirming the reset with the operator and for
// stopping the running Relay first. Both are enforced here rather than trusted:
// the buffer directory is validated before os.RemoveAll is pointed at it, and
// the reset refuses while another process holds the database lock.
func Run(ctx context.Context, cfg *config.Config, opts Options) error {
	// Check the destructive path target first, so a bad BUFFER_DIR aborts with
	// the database and Redis untouched rather than after the database is gone.
	if err := validateBufferDir(cfg.BufferDir); err != nil {
		return err
	}

	if !opts.Force {
		release, err := db.AcquireDBLock(cfg.DBPath)
		if err != nil {
			return fmt.Errorf("refusing to reset: the relay is still running (database lock held): %w", err)
		}
		release()
	}

	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Remove(cfg.DBPath + suffix); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("removing %s: %w", cfg.DBPath+suffix, err)
		}
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
	// 0700 to match buffer.New: this re-creates the buffer root after a wipe, and
	// a laxer mode here would undo the restriction on every factory reset.
	if err := os.MkdirAll(cfg.BufferDir, 0o700); err != nil {
		return fmt.Errorf("recreating buffer directory: %w", err)
	}
	return nil
}
