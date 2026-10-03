package reset

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// The reset guard is now the database lock: a running relay holds it for its
// lifetime, so a reset without -force refuses. These tests hold the lock
// directly to model the running process.

func TestRunRefusesWhileDatabaseLocked(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "relay.db")

	pool, err := db.Open(ctx, &config.Config{DBPath: path})
	require.NoError(t, err)
	var exists int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='accounts'`).Scan(&exists))
	require.Equal(t, 1, exists, "precondition: the accounts table exists")

	// Run while the pool still holds the lock, with Redis unreachable: the lock
	// guard must fire before the Redis connection is attempted.
	err = Run(ctx, &config.Config{
		DBPath:    path,
		BufferDir: t.TempDir(),
		RedisURL:  "redis://127.0.0.1:1/0",
	}, Options{})
	require.Error(t, err)
	require.Contains(t, err.Error(), "refusing to reset")

	// The database is untouched.
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='accounts'`).Scan(&exists))
	require.Equal(t, 1, exists, "a refused reset must leave the database in place")
	pool.Close()

	// Once the lock is released the guard no longer refuses for that reason.
	release, err := db.AcquireDBLock(path)
	require.NoError(t, err)
	release()
}

// TestRunRefusesDangerousBufferDirBeforeTouchingDatabase proves the ordering:
// the path guard fires first, so a bad BUFFER_DIR aborts with the database
// intact rather than after the file has already been deleted.
func TestRunRefusesDangerousBufferDirBeforeTouchingDatabase(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "relay.db")

	pool, err := db.Open(ctx, &config.Config{DBPath: path})
	require.NoError(t, err)
	defer pool.Close()
	var exists int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='accounts'`).Scan(&exists))
	require.Equal(t, 1, exists, "precondition: the accounts table exists")

	for _, dir := range []string{"/", "/etc", "", "relative/buffer"} {
		err := Run(ctx, &config.Config{DBPath: path, BufferDir: dir}, Options{Force: true})
		require.Error(t, err, "BUFFER_DIR %q must be refused", dir)
		require.Contains(t, err.Error(), "refusing to reset")
	}

	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='accounts'`).Scan(&exists))
	require.Equal(t, 1, exists, "a refused reset must leave the database untouched")
}
