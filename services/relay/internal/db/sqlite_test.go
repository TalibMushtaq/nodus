package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"
)

// The SQLite path is additive until the cutover, so these white-box tests
// exercise openSQLite directly: the baseline schema applies, the pragmas hold
// on every pooled connection (not just the first), and the savepoint wrapper
// gives the same rollback-and-continue semantics as the former nested
// transaction.

func newSQLitePool(t *testing.T) *Pool {
	t.Helper()
	path := filepath.Join(t.TempDir(), "relay.db")
	pool, err := openSQLite(context.Background(), path)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	return pool
}

func TestSQLiteBaselineApplies(t *testing.T) {
	pool := newSQLitePool(t)
	ctx := context.Background()

	// A representative table from each migration cluster, not just the first.
	for _, table := range []string{
		"accounts", "devices", "storage_nodes", "files", "file_versions",
		"file_locations", "key_envelopes", "folder_key_envelopes", "folders",
		"pairing_codes", "pairing_sessions", "sessions", "sync_events",
		"sync_cursors", "tombstones", "tombstone_node_status", "activities",
		"conflict_notices", "rebuild_requests", "web_push_subscriptions",
	} {
		var name string
		err := pool.QueryRow(ctx,
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&name)
		require.NoErrorf(t, err, "table %s missing from baseline", table)
		require.Equal(t, table, name)
	}

	// The load-bearing unique constraint for event dedup must be enforced.
	// SQLite creates the index implicitly for a table-level UNIQUE, so check
	// the behavior rather than the index catalog.
	_, err := pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
		"acct-uniq", "uniq@test.local", "h", 0)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO sync_events (event_id, account_id, origin_id, origin_sequence, event_type, payload, "timestamp") VALUES (?, ?, ?, ?, ?, ?, ?)`,
		"evt-1", "acct-uniq", "origin", 1, "FILE_CREATED", "{}", 0)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO sync_events (event_id, account_id, origin_id, origin_sequence, event_type, payload, "timestamp") VALUES (?, ?, ?, ?, ?, ?, ?)`,
		"evt-2", "acct-uniq", "origin", 1, "FILE_CREATED", "{}", 0)
	require.Error(t, err)
	require.ErrorIs(t, err, ErrUniqueViolation)

	// Re-running migrations on an already-migrated file must be a no-op.
	require.NoError(t, RunSQLiteMigrations(poolPath(t, pool)))
}

// poolPath is a test helper that fails loudly if the pool is not file-backed.
func poolPath(t *testing.T, pool *Pool) string {
	t.Helper()
	var path string
	require.NoError(t, pool.writer.QueryRow(`PRAGMA database_list`).Scan(new(int), new(string), &path))
	require.NotEmpty(t, path)
	return path
}

func TestSQLitePragmasApplyToEveryPooledConnection(t *testing.T) {
	pool := newSQLitePool(t)
	ctx := context.Background()

	// Pin several reader connections at once; each must carry the pragmas.
	conns := make([]interface{ Close() error }, 0, 5)
	for i := 0; i < 5; i++ {
		conn, err := pool.reader.Conn(ctx)
		require.NoError(t, err)
		conns = append(conns, conn)

		var (
			foreignKeys int
			busyTimeout int
			journalMode string
		)
		require.NoError(t, conn.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&foreignKeys))
		require.NoError(t, conn.QueryRowContext(ctx, `PRAGMA busy_timeout`).Scan(&busyTimeout))
		require.NoError(t, conn.QueryRowContext(ctx, `PRAGMA journal_mode`).Scan(&journalMode))
		require.Equal(t, 1, foreignKeys, "foreign_keys must be on connection %d", i)
		require.Equal(t, 5000, busyTimeout, "busy_timeout must be set on connection %d", i)
		require.Equal(t, "wal", journalMode, "journal_mode must be WAL on connection %d", i)
	}
	for _, c := range conns {
		_ = c.Close()
	}
}

func TestSQLiteSavepointRollbackKeepsOuterWork(t *testing.T) {
	pool := newSQLitePool(t)
	ctx := context.Background()

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer tx.Rollback(ctx) //nolint:errcheck

	_, err = tx.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
		"acct-outer", "outer@test.local", "h", 0)
	require.NoError(t, err)

	sp, err := tx.Begin(ctx)
	require.NoError(t, err)
	_, err = sp.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
		"acct-inner", "inner@test.local", "h", 0)
	require.NoError(t, err)
	require.NoError(t, sp.Rollback(ctx))

	// The outer transaction continues after the savepoint rollback.
	_, err = tx.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
		"acct-after", "after@test.local", "h", 0)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))

	var outer, inner int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM accounts WHERE account_id = ?`, "acct-outer").Scan(&outer))
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM accounts WHERE account_id = ?`, "acct-inner").Scan(&inner))
	require.Equal(t, 1, outer, "work before the savepoint must survive")
	require.Equal(t, 0, inner, "work inside the rolled-back savepoint must be gone")

	var after int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM accounts WHERE account_id = ?`, "acct-after").Scan(&after))
	require.Equal(t, 1, after, "the outer transaction must be usable after ROLLBACK TO")
}

func TestSQLiteForeignKeyEnforced(t *testing.T) {
	pool := newSQLitePool(t)
	ctx := context.Background()

	_, err := pool.Exec(ctx, `INSERT INTO devices (device_id, account_id, public_key, created_at) VALUES (?, ?, ?, ?)`,
		"dev-orphan", "no-such-account", "pk", 0)
	require.Error(t, err)
	require.ErrorIs(t, err, ErrForeignKey)
}

// TestSQLiteBusyIsRetryable pins the mapping the service relies on: a write that
// cannot take the single writer lock returns ErrBusy rather than blocking
// forever, and the next attempt succeeds once the competing transaction ends.
// It uses a short busy_timeout so the test is fast; production uses 5000ms.
func TestSQLiteBusyIsRetryable(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping lock-contention test in -short mode")
	}
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "relay.db")
	require.NoError(t, RunSQLiteMigrations(path))

	// A raw connection (not a Pool, so it does not take the relay file lock)
	// holds the write lock with BEGIN IMMEDIATE.
	raw, err := openRawSQLite(path, 1)
	require.NoError(t, err)
	defer raw.Close()
	tx, err := raw.BeginTx(ctx, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback() })

	// A pool with a tiny busy_timeout so the test does not wait the production
	// five seconds.
	writer, err := openRawSQLite(path, 100)
	require.NoError(t, err)
	pool := &Pool{writer: writer, reader: writer}
	defer pool.Close()

	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)`,
		"acct-busy", "busy@test.local", "h", 0)
	require.Error(t, err)
	require.ErrorIs(t, err, ErrBusy, "a held write lock must surface as a retryable ErrBusy")

	// Releasing the competing transaction lets the same write succeed.
	require.NoError(t, tx.Rollback())
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)`,
		"acct-busy", "busy@test.local", "h", 0)
	require.NoError(t, err)
}

// openRawSQLite opens a bare *sql.DB with the given busy_timeout (ms) and
// _txlock=immediate so BEGIN takes the write lock up front.
func openRawSQLite(path string, busyMS int) (*sql.DB, error) {
	dsn := "file:" + path + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(" +
		strconv.Itoa(busyMS) + ")&_txlock=immediate"
	return sql.Open("sqlite", dsn)
}

// TestSQLiteNotFoundMapping pins the no-rows sentinel the service matches on.
func TestSQLiteNotFoundMapping(t *testing.T) {
	pool := newSQLitePool(t)
	ctx := context.Background()
	var id string
	err := pool.QueryRow(ctx, `SELECT account_id FROM accounts WHERE account_id = $1`, "nope").Scan(&id)
	require.ErrorIs(t, err, ErrNotFound)
}
