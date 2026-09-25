package reset

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// TestCheckNoLiveConnectionsNeedsForce asserts the guard that enforces "stop the
// Relay first". The package documentation already required the operator to do
// that; without this check a reset dropped the schema underneath a running
// server, leaving it erroring against missing tables.
//
// The suite shares one test database across packages and Go runs those packages
// in parallel, so other clients are usually attached. The assertions therefore
// key off a connection this test owns, identified by its application_name,
// instead of assuming it is the only one.
func TestCheckNoLiveConnectionsNeedsForce(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()

	conn, err := pgx.Connect(ctx, url)
	require.NoError(t, err)
	defer conn.Close(ctx) //nolint:errcheck

	other, err := pgx.Connect(ctx, appendApplicationName(url, "reset-guard-probe"))
	require.NoError(t, err)
	var otherPID int32
	require.NoError(t, other.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&otherPID))

	blocked := checkNoLiveConnections(ctx, conn, false)
	require.Error(t, blocked, "an attached connection must block the reset")
	require.Contains(t, blocked.Error(), "refusing to reset")
	require.Contains(t, blocked.Error(), "reset-guard-probe",
		"the error must identify the attached client so the operator can find it")
	require.Contains(t, blocked.Error(), "-factory-reset-force", "the error must name the override")
	require.Contains(t, blocked.Error(), fmt.Sprintf("pid %d", otherPID))

	require.NoError(t, checkNoLiveConnections(ctx, conn, true),
		"the override must let an operator who knows the connection is theirs proceed")

	// Once our probe disconnects it must stop being reported, which proves the
	// guard reads live connection state rather than always refusing.
	require.NoError(t, other.Close(ctx))
	after := checkNoLiveConnections(ctx, conn, false)
	if after != nil {
		require.NotContains(t, after.Error(), "reset-guard-probe",
			"a closed connection must not keep blocking the reset")
	}
}

// appendApplicationName tags a connection so the guard's report names it.
func appendApplicationName(url, name string) string {
	sep := "?"
	if strings.Contains(url, "?") {
		sep = "&"
	}
	return url + sep + "application_name=" + name
}

// TestRunRefusesDangerousBufferDirBeforeTouchingDatabase proves the ordering:
// the path guard fires first, so a bad BUFFER_DIR aborts with the schema still
// intact rather than after the drop has already happened.
func TestRunRefusesDangerousBufferDirBeforeTouchingDatabase(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	require.NoError(t, db.RunMigrations(url))

	ctx := context.Background()
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	defer pool.Close()

	require.NoError(t, pool.QueryRow(ctx,
		`SELECT to_regclass('public.accounts') IS NOT NULL`).Scan(new(bool)),
		"precondition: the accounts table exists")

	for _, dir := range []string{"/", "/etc", "", "relative/buffer"} {
		err := Run(ctx, &config.Config{DatabaseURL: url, BufferDir: dir}, Options{Force: true})
		require.Error(t, err, "BUFFER_DIR %q must be refused", dir)
		require.Contains(t, err.Error(), "refusing to reset")
	}

	var stillThere bool
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT to_regclass('public.accounts') IS NOT NULL`).Scan(&stillThere))
	require.True(t, stillThere, "a refused reset must leave the schema untouched")
}

// TestRunRefusesWhileConnected wires the two guards together the way main.go
// does, and confirms the connection check runs before the drop.
func TestRunRefusesWhileConnected(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	require.NoError(t, db.RunMigrations(url))
	ctx := context.Background()

	other, err := pgx.Connect(ctx, url)
	require.NoError(t, err)
	defer other.Close(ctx) //nolint:errcheck

	bufferDir := t.TempDir()
	// Redis is intentionally unreachable: if the guard did not fire first, Run
	// would fail with a connection error instead of the refusal below, and the
	// schema drop would already have happened.
	err = Run(ctx, &config.Config{
		DatabaseURL: url,
		BufferDir:   bufferDir,
		RedisURL:    "redis://127.0.0.1:1/0",
	}, Options{})
	require.Error(t, err)
	require.Contains(t, err.Error(), "refusing to reset",
		"the live-connection guard must fire before the schema drop")

	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	defer pool.Close()
	var stillThere bool
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT to_regclass('public.accounts') IS NOT NULL`).Scan(&stillThere))
	require.True(t, stillThere, "the refused reset must leave the schema in place")
}
