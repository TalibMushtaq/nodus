package handler

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require" //nolint:depguard

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// The cursor map in a snapshot's BEGIN payload is not covered by the node's
// signature: HandleSnapshotBegin verifies Ed25519 over `content_hash` only, and
// `cursors` is a sibling field. Promotion used to write it into sync_cursors
// verbatim with DO UPDATE SET, so the account's primary node could forge any
// peer's cursor. These tests pin what the Relay now refuses to believe.

// cursorFixture seeds an account, a primary node, one staged file, and a
// `sync_events` log whose high-water mark is `logHigh` for origin `logOrigin`.
func cursorFixture(t *testing.T, logOrigin string, logHigh int64) (ctx context.Context, pool *db.Pool, account, node string) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx = context.Background()
	require.NoError(t, db.RunMigrations(url))
	p, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(p.Close)

	s := fmt.Sprint(time.Now().UnixNano())
	account, node = "acct-cur-"+s, "node-cur-"+s
	cleanup := []string{"rebuild_files", "sync_events", "sync_cursors", "files", "storage_nodes", "accounts"}
	for _, table := range cleanup {
		mustExec(t, p, fmt.Sprintf(`DELETE FROM %s WHERE account_id=$1`, table), account)
	}
	mustExec(t, p, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1,$2,'x')`,
		account, account+"@test.dev")
	mustExec(t, p, `INSERT INTO storage_nodes (node_id, account_id, public_key, is_primary) VALUES ($1,$2,'pk',true)`,
		node, account)
	// One staged file, so a successful promotion has something to install.
	mustExec(t, p, `INSERT INTO rebuild_files (file_id, account_id, encrypted_name) VALUES ($1,$2,'snap')`,
		"file-"+s, account)

	if logOrigin != "" {
		for seq := int64(1); seq <= logHigh; seq++ {
			mustExec(t, p, `
				INSERT INTO sync_events (event_id, account_id, origin_id, origin_sequence, event_type, payload, timestamp)
				VALUES ($1, $2, $3, $4, 'FILE_MODIFIED', '{}'::jsonb, NOW())`,
				fmt.Sprintf("evt-%s-%d", s, seq), account, logOrigin, seq)
		}
	}
	return ctx, p, account, node
}

func cursorOf(t *testing.T, ctx context.Context, pool *db.Pool, account, peer string) (int64, bool) {
	t.Helper()
	var seq int64
	err := pool.QueryRow(ctx,
		`SELECT last_sequence FROM sync_cursors WHERE account_id=$1 AND peer_id=$2`, account, peer).Scan(&seq)
	if err != nil {
		return 0, false
	}
	return seq, true
}

// TestSnapshotCursorAboveRelayLogIsRejected is the core of the finding: a forged
// cursor past the Relay's high-water mark must abort the promotion. Without the
// check the peer's next real event is rejected as a sequence regression forever
// (no API lowers a cursor), and every event between the real mark and the forged
// one is never delivered to any peer during catch-up sync.
func TestSnapshotCursorAboveRelayLogIsRejected(t *testing.T) {
	ctx, pool, account, node := cursorFixture(t, "device-honest", 7)

	sess := &rebuildSession{
		snapshotID: "snap-forged", nodeID: node, accountID: account,
		cursors: []SnapshotCursor{{OriginID: "device-honest", Sequence: 9_999_999}},
	}
	err := promoteRebuild(ctx, pool, sess)
	require.Error(t, err, "a cursor above the relay's high-water mark must abort promotion")
	require.Contains(t, err.Error(), "device-honest")

	// The forgery must not have landed, and the promotion must have rolled back
	// completely: no staged file, no cursor.
	_, found := cursorOf(t, ctx, pool, account, "device-honest")
	require.False(t, found, "the forged cursor must not be written")
	var staged int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM files WHERE account_id=$1 AND file_id LIKE 'file-%'`, account).Scan(&staged))
	require.Zero(t, staged, "a rejected promotion must leave the live tables untouched")
}

// TestSnapshotCursorAtRelayLogMaxIsAccepted pins the boundary: a cursor exactly
// at the Relay's high-water mark is the honest case and must still promote.
func TestSnapshotCursorAtRelayLogMaxIsAccepted(t *testing.T) {
	ctx, pool, account, node := cursorFixture(t, "device-honest", 7)

	sess := &rebuildSession{
		snapshotID: "snap-exact", nodeID: node, accountID: account,
		cursors: []SnapshotCursor{{OriginID: "device-honest", Sequence: 7}},
	}
	require.NoError(t, promoteRebuild(ctx, pool, sess))

	seq, found := cursorOf(t, ctx, pool, account, "device-honest")
	require.True(t, found, "the snapshot's cursor must be installed")
	require.Equal(t, int64(7), seq)
}

// TestSnapshotCursorBehindRelayLogIsAccepted covers a node that is behind the
// Relay. Promotion deliberately resets the cursor to the snapshot checkpoint, so
// the gap replays; that is the safe direction and must stay allowed.
func TestSnapshotCursorBehindRelayLogIsAccepted(t *testing.T) {
	ctx, pool, account, node := cursorFixture(t, "device-honest", 7)

	sess := &rebuildSession{
		snapshotID: "snap-behind", nodeID: node, accountID: account,
		cursors: []SnapshotCursor{{OriginID: "device-honest", Sequence: 2}},
	}
	require.NoError(t, promoteRebuild(ctx, pool, sess))
	seq, found := cursorOf(t, ctx, pool, account, "device-honest")
	require.True(t, found)
	require.Equal(t, int64(2), seq)
}

// TestSnapshotCursorForOriginWithNoLogIsAccepted is the post-factory-reset
// rebuild. A reset drops the whole schema, so sync_events is empty while the
// node still holds its cursors — there is nothing to check the claim against,
// and the node is the only authority for its own state. Rejecting this would
// break the exact scenario a rebuild exists to fix.
func TestSnapshotCursorForOriginWithNoLogIsAccepted(t *testing.T) {
	ctx, pool, account, node := cursorFixture(t, "", 0)

	sess := &rebuildSession{
		snapshotID: "snap-postreset", nodeID: node, accountID: account,
		cursors: []SnapshotCursor{
			{OriginID: "device-1", Sequence: 512},
			{OriginID: "device-2", Sequence: 1},
		},
	}
	require.NoError(t, promoteRebuild(ctx, pool, sess))
	seq, found := cursorOf(t, ctx, pool, account, "device-1")
	require.True(t, found)
	require.Equal(t, int64(512), seq)
}

// TestSnapshotCursorMapShapeIsValidated covers the malformed shapes: a negative
// sequence rewinds an origin and lets it re-apply already-applied events, a
// duplicate entry is ambiguous, and an empty origin id has no meaning.
func TestSnapshotCursorMapShapeIsValidated(t *testing.T) {
	cases := []struct {
		name    string
		cursors []SnapshotCursor
		wantErr string
	}{
		{"negative sequence", []SnapshotCursor{{OriginID: "d1", Sequence: -1}}, "negative sequence"},
		{"empty origin", []SnapshotCursor{{OriginID: "", Sequence: 3}}, "empty origin_id"},
		{"duplicate origin", []SnapshotCursor{
			{OriginID: "d1", Sequence: 1}, {OriginID: "d1", Sequence: 2},
		}, "twice"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx, pool, account, node := cursorFixture(t, "d1", 5)
			sess := &rebuildSession{
				snapshotID: "snap-shape", nodeID: node, accountID: account, cursors: tc.cursors,
			}
			err := promoteRebuild(ctx, pool, sess)
			require.Error(t, err)
			require.Contains(t, err.Error(), tc.wantErr)
			_, found := cursorOf(t, ctx, pool, account, "d1")
			require.False(t, found, "no cursor may be installed from a rejected map")
		})
	}
}

// TestSnapshotCursorValidationIsAccountScoped makes sure the high-water mark
// lookup cannot be satisfied with another account's log, which would let a
// forged cursor pass by pointing at a busy origin.
func TestSnapshotCursorValidationIsAccountScoped(t *testing.T) {
	ctx, pool, account, node := cursorFixture(t, "d1", 2)

	// A different account with a long log under the same peer id.
	other := "acct-other-" + account
	mustExec(t, pool, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1,$2,'x')`, other, "o@test.dev")
	for seq := int64(1); seq <= 50; seq++ {
		mustExec(t, pool, `
			INSERT INTO sync_events (event_id, account_id, origin_id, origin_sequence, event_type, payload, timestamp)
			VALUES ($1, $2, 'd1', $3, 'FILE_MODIFIED', '{}'::jsonb, NOW())`,
			fmt.Sprintf("evt-other-%d", seq), other, seq)
	}
	t.Cleanup(func() {
		mustExec(t, pool, `DELETE FROM sync_events WHERE account_id=$1`, other)
		mustExec(t, pool, `DELETE FROM accounts WHERE account_id=$1`, other)
	})

	// This account's own log for d1 stops at 2, so a claim of 40 is forged even
	// though some account has seen 50 events from a peer also called "d1".
	sess := &rebuildSession{
		snapshotID: "snap-scoped", nodeID: node, accountID: account,
		cursors: []SnapshotCursor{{OriginID: "d1", Sequence: 40}},
	}
	err := promoteRebuild(ctx, pool, sess)
	require.Error(t, err)
	require.Contains(t, err.Error(), "highest accepted event")
}
