package tombstone

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/testutil"
)

type pruneEnv struct {
	pool *db.Pool
	ctx  context.Context
}

func setupPrune(t *testing.T) *pruneEnv {
	t.Helper()
	pool, ctx := testutil.OpenTestDB(t)
	return &pruneEnv{pool: pool, ctx: ctx}
}

// account returns a fresh account id, isolated from other tests' rows.
func (e *pruneEnv) account(t *testing.T) string {
	t.Helper()
	id := "acct-prune-" + fmt.Sprint(time.Now().UnixNano())
	_, err := e.pool.Exec(e.ctx,
		`INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'h')`,
		id, id+"@test.local")
	require.NoError(t, err)
	return id
}

// tombstone inserts one tombstone. deletedAt and purgeAfter are separate on
// purpose: the whole point of the test suite is that they can disagree.
func (e *pruneEnv) tombstone(t *testing.T, account, entityType, entityID string, deletedAt, purgeAfter time.Time) {
	t.Helper()
	_, err := e.pool.Exec(e.ctx, `
		INSERT INTO tombstones (account_id, entity_type, entity_id, deleted_at, purge_after)
		VALUES ($1, $2, $3, $4, $5)
	`, account, entityType, entityID, deletedAt, purgeAfter)
	require.NoError(t, err)
}

func (e *pruneEnv) countTombstones(t *testing.T, account string) int {
	t.Helper()
	var n int
	require.NoError(t, e.pool.QueryRow(e.ctx,
		`SELECT COUNT(*) FROM tombstones WHERE account_id = $1`, account).Scan(&n))
	return n
}

// TestPruneHonoursPurgeAfterNotDeletedAt is the regression test for the wrong
// predicate. The delete path sets purge_after on insert and keeps the original
// on a re-delete, so a restore+delete cycle does not extend the window — a row
// re-deleted yesterday whose deadline passed a week ago has served its full 90
// days. Keying the prune off deleted_at meant such rows were never purged.
func TestPruneHonoursPurgeAfterNotDeletedAt(t *testing.T) {
	e := setupPrune(t)
	acct := e.account(t)
	now := time.Now().UTC()

	// Re-deleted yesterday, but the original 90-day window closed a week ago.
	e.tombstone(t, acct, "file", "file-recent-delete-old-deadline", now.Add(-24*time.Hour), now.Add(-7*24*time.Hour))
	// Deleted 200 days ago: unambiguously expired, and must still go.
	e.tombstone(t, acct, "file", "file-long-expired", now.Add(-200*24*time.Hour), now.Add(-110*24*time.Hour))
	// Window still open: must be left alone.
	e.tombstone(t, acct, "file", "file-still-restorable", now.Add(-10*24*time.Hour), now.Add(+80*24*time.Hour))

	purged, err := pruneExpiredTombstones(e.ctx, e.pool)
	require.NoError(t, err)
	require.Equal(t, 2, purged)

	require.Equal(t, 1, e.countTombstones(t, acct), "only the restorable tombstone should remain")
	var remaining string
	require.NoError(t, e.pool.QueryRow(e.ctx,
		`SELECT entity_id FROM tombstones WHERE account_id = $1`, acct).Scan(&remaining))
	require.Equal(t, "file-still-restorable", remaining)
}

// TestPruneDeletesTheEntityToo covers the reason the purge exists at all: only
// deleting the tombstone would make a long-deleted file reappear, because
// `GET /files` hides an entity by checking for a tombstone.
func TestPruneDeletesTheEntityToo(t *testing.T) {
	e := setupPrune(t)
	acct := e.account(t)
	expired := time.Now().UTC().Add(-time.Hour)

	// file_locations.node_id references storage_nodes, so a holder has to exist
	// before a stored location can.
	_, err := e.pool.Exec(e.ctx,
		`INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ($1, $2, 'ab')`,
		"node-prune-"+acct, acct)
	require.NoError(t, err)

	const file = "file-gone"
	_, err = e.pool.Exec(e.ctx,
		`INSERT INTO files (file_id, account_id, encrypted_name) VALUES ($1, $2, 'n.a')`, file, acct)
	require.NoError(t, err)
	_, err = e.pool.Exec(e.ctx,
		`INSERT INTO file_versions (file_id, version_number, version_hash, shard_count)
		 VALUES ($1, 1, 'vh', 1)`, file)
	require.NoError(t, err)
	_, err = e.pool.Exec(e.ctx,
		`INSERT INTO key_envelopes (file_id, recipient_id, encrypted_key) VALUES ($1, 'dev-1', 'k')`, file)
	require.NoError(t, err)
	_, err = e.pool.Exec(e.ctx, `
		INSERT INTO file_locations (file_id, version_number, shard_index, node_id, hash, size_bytes, status)
		VALUES ($1, 1, 0, $2, $3, 10, 'NODE_STORED')`,
		file, "node-prune-"+acct, fmt.Sprintf("%064x", len(file)))
	require.NoError(t, err)
	_, err = e.pool.Exec(e.ctx,
		`INSERT INTO folders (folder_id, account_id, encrypted_name) VALUES ('folder-gone', $1, 'n.a')`, acct)
	require.NoError(t, err)

	e.tombstone(t, acct, "file", file, time.Now().UTC().Add(-200*24*time.Hour), expired)
	e.tombstone(t, acct, "folder", "folder-gone", time.Now().UTC().Add(-200*24*time.Hour), expired)

	_, err = pruneExpiredTombstones(e.ctx, e.pool)
	require.NoError(t, err)

	for _, table := range []string{"files", "file_versions", "key_envelopes", "file_locations"} {
		var n int
		require.NoError(t, e.pool.QueryRow(e.ctx,
			`SELECT COUNT(*) FROM `+table+` WHERE file_id = $1`, file).Scan(&n))
		require.Zero(t, n, "%s still holds the purged entity", table)
	}
	var folders int
	require.NoError(t, e.pool.QueryRow(e.ctx,
		`SELECT COUNT(*) FROM folders WHERE folder_id = 'folder-gone'`).Scan(&folders))
	require.Zero(t, folders, "the purged folder row is still there")
}

// TestPruneSkipsRowsAnotherTransactionHolds is the batching regression test. A
// single transaction over the whole backlog means any row another transaction
// happens to hold blocks every other purge behind it and nothing commits at all
// — one locked row stalled all 19 other purges.
func TestPruneSkipsRowsAnotherTransactionHolds(t *testing.T) {
	e := setupPrune(t)
	acct := e.account(t)
	expired := time.Now().UTC().Add(-time.Hour)

	const total = 20
	held := "file-held"
	for i := range total {
		id := fmt.Sprintf("file-locked-%d", i)
		if i == 0 {
			id = held
		}
		e.tombstone(t, acct, "file", id, time.Now().UTC().Add(-200*24*time.Hour), expired)
	}

	// A second connection holds a row lock on one tombstone, as a concurrent
	// sweep or any long-running transaction on the table would.
	other, err := db.Open(e.ctx, &config.Config{DatabaseURL: os.Getenv("TEST_DATABASE_URL")})
	require.NoError(t, err)
	t.Cleanup(other.Close)
	otx, err := other.Begin(e.ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = otx.Rollback(context.Background()) })
	_, err = otx.Exec(e.ctx, `SELECT 1 FROM tombstones WHERE account_id = $1 AND entity_id = $2 FOR UPDATE`, acct, held)
	require.NoError(t, err)

	// The sweep must finish anyway. If it blocks, this is the failure: a prune
	// that cannot make progress because of an unrelated transaction is a prune
	// that never runs.
	done := make(chan struct {
		purged int
		err    error
	}, 1)
	go func() {
		purged, err := pruneExpiredTombstones(e.ctx, e.pool)
		done <- struct {
			purged int
			err    error
		}{purged, err}
	}()

	select {
	case result := <-done:
		require.NoError(t, result.err)
		require.Equal(t, total-1, result.purged,
			"every tombstone except the locked one should have been purged")
	case <-time.After(10 * time.Second):
		t.Fatal("the prune blocked behind an unrelated row lock instead of skipping it")
	}

	require.Equal(t, 1, e.countTombstones(t, acct), "only the locked tombstone should remain")

	// Once the lock is released the held row is picked up by a later sweep, so
	// skipping it costs nothing but a delay.
	require.NoError(t, otx.Rollback(e.ctx))
	purged, err := pruneExpiredTombstones(e.ctx, e.pool)
	require.NoError(t, err)
	require.Equal(t, 1, purged)
	require.Zero(t, e.countTombstones(t, acct))
}

// TestPruneWorksThroughABacklogLargerThanOneBatch covers the batching itself: a
// backlog bigger than a single transaction still gets fully purged.
func TestPruneWorksThroughABacklogLargerThanOneBatch(t *testing.T) {
	e := setupPrune(t)
	acct := e.account(t)
	expired := time.Now().UTC().Add(-time.Hour)

	const total = pruneBatchSize + 37
	for i := range total {
		e.tombstone(t, acct, "file", fmt.Sprintf("file-backlog-%d", i),
			time.Now().UTC().Add(-200*24*time.Hour), expired)
	}

	purged, err := pruneExpiredTombstones(e.ctx, e.pool)
	require.NoError(t, err)
	require.Equal(t, total, purged, "the whole backlog should be purged, in batches")
	require.Zero(t, e.countTombstones(t, acct))
}

// TestPruneDoesNotFollowATombstoneIntoAnotherAccountsData is the cross-account
// regression test. A tombstone's entity_id is not bound to an entity the
// account owns: sync.go takes it from the client's delete event and files it
// under the authenticated account, so a client can tombstone any id it can name
// and, 90 days later, have the purge delete someone else's file. The purge has
// to check ownership, and it has to check it before the child tables — those
// carry no account_id and can only be filtered by file_id.
func TestPruneDoesNotFollowATombstoneIntoAnotherAccountsData(t *testing.T) {
	e := setupPrune(t)
	victim := e.account(t)
	attacker := e.account(t)
	expired := time.Now().UTC().Add(-time.Hour)

	const victimFile = "file-belonging-to-victim"
	_, err := e.pool.Exec(e.ctx,
		`INSERT INTO files (file_id, account_id, encrypted_name) VALUES ($1, $2, 'n.a')`, victimFile, victim)
	require.NoError(t, err)
	_, err = e.pool.Exec(e.ctx,
		`INSERT INTO file_versions (file_id, version_number, version_hash, shard_count)
		 VALUES ($1, 1, 'vh', 1)`, victimFile)
	require.NoError(t, err)
	_, err = e.pool.Exec(e.ctx,
		`INSERT INTO key_envelopes (file_id, recipient_id, encrypted_key) VALUES ($1, 'dev-1', 'k')`, victimFile)
	require.NoError(t, err)

	// The attacker tombstones an id it does not own, and waits out the window.
	e.tombstone(t, attacker, "file", victimFile, time.Now().UTC().Add(-200*24*time.Hour), expired)

	purged, err := pruneExpiredTombstones(e.ctx, e.pool)
	require.NoError(t, err)
	require.Equal(t, 1, purged, "the expired tombstone itself is still pruned")
	require.Zero(t, e.countTombstones(t, attacker))

	for _, table := range []string{"files", "file_versions", "key_envelopes"} {
		var n int
		require.NoError(t, e.pool.QueryRow(e.ctx,
			`SELECT COUNT(*) FROM `+table+` WHERE file_id = $1`, victimFile).Scan(&n))
		require.Equal(t, 1, n, "%s lost a row belonging to another account", table)
	}
}

// TestPruneKeepsUnownedTombstonesFromBlockingTheRest checks the same guard does
// not stall the sweep: a tombstone naming nothing the account holds is still
// purged, on its own account's terms.
func TestPruneKeepsUnownedTombstonesFromBlockingTheRest(t *testing.T) {
	e := setupPrune(t)
	acct := e.account(t)
	expired := time.Now().UTC().Add(-time.Hour)

	// Nothing named "never-existed" is owned by anyone here.
	e.tombstone(t, acct, "file", "never-existed", time.Now().UTC().Add(-200*24*time.Hour), expired)
	// A folder tombstone whose folder is already gone, e.g. purged by a
	// requested purge that removed the row but left the tombstone.
	e.tombstone(t, acct, "folder", "already-gone", time.Now().UTC().Add(-200*24*time.Hour), expired)

	purged, err := pruneExpiredTombstones(e.ctx, e.pool)
	require.NoError(t, err)
	require.Equal(t, 2, purged)
	require.Zero(t, e.countTombstones(t, acct))
}

// TestPruneWithoutPoolIsNoop keeps the nil guard the background worker relies on
// when the relay starts without a database.
func TestPruneWithoutPoolIsNoop(t *testing.T) {
	purged, err := pruneExpiredTombstones(context.Background(), nil)
	require.NoError(t, err)
	require.Zero(t, purged)
}
