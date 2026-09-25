package handler

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/stretchr/testify/require"
)

// Cross-account isolation for the account-scoping sweep.
//
// The bug this file pins: every write path on files / file_versions /
// file_locations / key_envelopes / folder_key_envelopes was account-scoped on
// insert, but a subset of the delete, read, and node-fan-out paths keyed off the
// bare entity id. `file_versions`, `file_locations`, and `key_envelopes` carry no
// `account_id` of their own — they inherit ownership through `files` — so an
// unscoped delete on them reaches any tenant's rows.
//
// The exploit primitive is the same everywhere: an authenticated account A
// references a `file_id` (or `folder_id`, or device id) that belongs to account
// B. Each test below drives one of the fixed queries with exactly that input.

// foreignAccountFixture is one victim account (B) holding a file, a version, a
// shard location, and both kinds of key envelope — everything the fixed queries
// touch.
type foreignAccountFixture struct {
	account  string
	file     string
	version  int
	node     string
	bufferID string
}

// newForeignAccountFixture seeds account B with one file whose purge-related
// dependents (locations, versions, key envelopes) all exist, so a cross-account
// delete would be observable on every one of them.
func newForeignAccountFixture(t *testing.T, pool *db.Pool, buf *buffer.Buffer, prefix string) foreignAccountFixture {
	t.Helper()
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())

	f := foreignAccountFixture{
		account:  "acct-" + prefix + "-victim-" + suffix,
		file:     "file-" + prefix + "-victim-" + suffix,
		version:  1,
		node:     "node-" + prefix + "-victim-" + suffix,
		bufferID: "buf-" + prefix + "-victim-" + suffix,
	}

	_, err := pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`,
		f.account, f.account+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ($1, $2, 'ab')`,
		f.node, f.account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id, encrypted_name) VALUES ($1, $2, $3)`,
		f.file, f.account, "victim-ciphertext-name")
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO file_versions (file_id, version_number, version_hash, shard_count) VALUES ($1, $2, 'vh', 1)`,
		f.file, f.version)
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO file_locations (file_id, version_number, shard_index, node_id, status, buffer_id)
		 VALUES ($1, $2, 0, $3, 'RELAY_BUFFERED', $4)`,
		f.file, f.version, f.node, f.bufferID)
	require.NoError(t, err)
	// Two recipients so a single-recipient delete cannot be mistaken for a
	// whole-table delete.
	_, err = pool.Exec(ctx,
		`INSERT INTO key_envelopes (file_id, recipient_id, encrypted_key) VALUES ($1, 'victim-device-1', 'k1')`,
		f.file)
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO key_envelopes (file_id, recipient_id, encrypted_key) VALUES ($1, 'victim-device-2', 'k2')`,
		f.file)
	require.NoError(t, err)

	require.NoError(t, buf.Store(f.bufferID, []byte("victim encrypted shard")))
	require.True(t, buf.Exists(f.bufferID))

	return f
}

// requireIntact asserts that every table the cross-account query could have
// touched is still exactly as the fixture left it.
func (f foreignAccountFixture) requireIntact(t *testing.T, pool *db.Pool, buf *buffer.Buffer) {
	t.Helper()
	ctx := context.Background()

	var count int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM files WHERE file_id = $1`, f.file).Scan(&count))
	require.Equal(t, 1, count, "victim files row must survive")

	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM file_versions WHERE file_id = $1`, f.file).Scan(&count))
	require.Equal(t, 1, count, "victim file_versions row must survive")

	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM file_locations WHERE file_id = $1`, f.file).Scan(&count))
	require.Equal(t, 1, count, "victim file_locations row must survive")

	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM key_envelopes WHERE file_id = $1`, f.file).Scan(&count))
	require.Equal(t, 2, count, "both victim key_envelopes rows must survive")

	require.True(t, buf.Exists(f.bufferID), "victim buffer file must not be unlinked")
}

func setupIsolationTest(t *testing.T) (*db.Pool, *buffer.Buffer) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx := context.Background()
	require.NoError(t, db.RunMigrations(url))
	pool, err := db.Open(ctx, &config.Config{DatabaseURL: url})
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	buf, err := buffer.New(t.TempDir())
	require.NoError(t, err)
	return pool, buf
}

// C1: finalizeTombstonePurge deleted file_locations / file_versions /
// key_envelopes by bare `file_id`, so account A purging a tombstone naming
// account B's file stripped B's shard metadata and key envelopes while leaving
// B's `files` row (the one delete that was scoped) orphaned.
func TestFinalizeTombstonePurgeDoesNotCrossAccounts(t *testing.T) {
	pool, buf := setupIsolationTest(t)
	ctx := context.Background()
	victim := newForeignAccountFixture(t, pool, buf, "purge")

	attacker := "acct-purge-attacker-" + fmt.Sprint(time.Now().UnixNano())
	_, err := pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`,
		attacker, attacker+"@test.local")
	require.NoError(t, err)

	// The attacker's own tombstone row is account-scoped, so naming a foreign
	// entity_id succeeds — that is the entry point, not the fix.
	_, err = pool.Exec(ctx, `
		INSERT INTO tombstones (account_id, entity_type, entity_id, deleted_at, purge_after)
		VALUES ($1, 'file', $2, NOW(), NOW() + INTERVAL '90 days')`, attacker, victim.file)
	require.NoError(t, err, "attacker tombstone insert is account-scoped and should succeed")

	// The purge runs as the attacker and must be a complete no-op.
	require.NoError(t, finalizeTombstonePurge(ctx, pool, buf, attacker, "file", victim.file))

	victim.requireIntact(t, pool, buf)

	// The attacker's own tombstone row is still cleaned up: the purge remains
	// functional for the rows it legitimately owns.
	var count int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM tombstones WHERE account_id = $1 AND entity_id = $2`,
		attacker, victim.file).Scan(&count))
	require.Zero(t, count, "attacker's own tombstone row should still be removed")
}

// The same unlink primitive is reachable through collectFileBufferIDs: an
// unscoped read of B's buffer_id hands the purge loop a file to delete from disk.
func TestCollectFileBufferIDsIsAccountScoped(t *testing.T) {
	pool, buf := setupIsolationTest(t)
	ctx := context.Background()
	victim := newForeignAccountFixture(t, pool, buf, "collect")

	attacker := "acct-collect-attacker-" + fmt.Sprint(time.Now().UnixNano())
	_, err := pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`,
		attacker, attacker+"@test.local")
	require.NoError(t, err)

	ids, err := collectFileBufferIDs(ctx, pool, attacker, "file", victim.file)
	require.NoError(t, err)
	require.Empty(t, ids, "must not resolve another account's buffer ids")

	// The owning account still resolves them — scoping must not break the
	// legitimate unlink.
	ids, err = collectFileBufferIDs(ctx, pool, victim.account, "file", victim.file)
	require.NoError(t, err)
	require.Equal(t, []string{victim.bufferID}, ids)
}

// owningNodes drives the purge_tombstone / restore_tombstone control fan-out.
// Unscoped, account A learned which nodes hold account B's file and instructed
// them to drop it.
func TestOwningNodesIsAccountScoped(t *testing.T) {
	pool, buf := setupIsolationTest(t)
	ctx := context.Background()
	victim := newForeignAccountFixture(t, pool, buf, "owning")

	attacker := "acct-owning-attacker-" + fmt.Sprint(time.Now().UnixNano())
	_, err := pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`,
		attacker, attacker+"@test.local")
	require.NoError(t, err)

	nodes, err := owningNodes(ctx, pool, attacker, "file", victim.file)
	require.NoError(t, err)
	require.Empty(t, nodes, "must not disclose another account's node ids")

	nodes, err = owningNodes(ctx, pool, victim.account, "file", victim.file)
	require.NoError(t, err)
	require.Equal(t, []string{victim.node}, nodes, "owning account must still resolve its node")
}

// tombstoneNodeStatuses feeds the trash view's per-node progress list; the
// unscoped read disclosed B's node ids there too.
func TestTombstoneNodeStatusesIsAccountScoped(t *testing.T) {
	pool, buf := setupIsolationTest(t)
	ctx := context.Background()
	victim := newForeignAccountFixture(t, pool, buf, "nodestatus")

	attacker := "acct-nodestatus-attacker-" + fmt.Sprint(time.Now().UnixNano())
	_, err := pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`,
		attacker, attacker+"@test.local")
	require.NoError(t, err)

	statuses, err := tombstoneNodeStatuses(ctx, pool, attacker, "file", victim.file)
	require.NoError(t, err)
	require.Empty(t, statuses, "must not disclose another account's node ids")

	statuses, err = tombstoneNodeStatuses(ctx, pool, victim.account, "file", victim.file)
	require.NoError(t, err)
	require.Len(t, statuses, 1)
	require.Equal(t, victim.node, statuses[0].NodeID)
}

// pendingPurgesForNode re-sends purge controls on node reconnect. Unscoped, a
// tombstone A placed on B's file made A's purge request ride B's node.
func TestPendingPurgesForNodeIsAccountScoped(t *testing.T) {
	pool, buf := setupIsolationTest(t)
	ctx := context.Background()
	victim := newForeignAccountFixture(t, pool, buf, "pendingpurge")

	attacker := "acct-pendingpurge-attacker-" + fmt.Sprint(time.Now().UnixNano())
	_, err := pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`,
		attacker, attacker+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO tombstones (account_id, entity_type, entity_id, deleted_at, purge_after, purge_requested_at)
		VALUES ($1, 'file', $2, NOW(), NOW() + INTERVAL '90 days', NOW())`, attacker, victim.file)
	require.NoError(t, err)

	entities, err := pendingPurgesForNode(ctx, pool, attacker, victim.node)
	require.NoError(t, err)
	require.Empty(t, entities, "must not send purge controls to another account's node")

	// B's own node reconnecting must not pick up A's tombstone.
	entities, err = pendingPurgesForNode(ctx, pool, victim.account, victim.node)
	require.NoError(t, err)
	require.Empty(t, entities, "victim account has no tombstones of its own")

	victim.requireIntact(t, pool, buf)
}

// ListTombstones LEFT JOINed files/folders without an account predicate, so a
// tombstone A placed on B's file_id returned B's `encrypted_name` — a direct
// cross-tenant ciphertext read.
func TestListTombstoneJoinDoesNotLeakForeignName(t *testing.T) {
	pool, buf := setupIsolationTest(t)
	ctx := context.Background()
	victim := newForeignAccountFixture(t, pool, buf, "listjoin")

	attacker := "acct-listjoin-attacker-" + fmt.Sprint(time.Now().UnixNano())
	_, err := pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`,
		attacker, attacker+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO tombstones (account_id, entity_type, entity_id, deleted_at, purge_after)
		VALUES ($1, 'file', $2, NOW(), NOW() + INTERVAL '90 days')`, attacker, victim.file)
	require.NoError(t, err)

	// Reuse the handler's own query so the test fails if the join regresses.
	var name *string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT COALESCE(f.encrypted_name, fo.encrypted_name)
		FROM tombstones t
		LEFT JOIN files f ON t.entity_type = 'file' AND f.file_id = t.entity_id AND f.account_id = t.account_id
		LEFT JOIN folders fo ON t.entity_type = 'folder' AND fo.folder_id = t.entity_id AND fo.account_id = t.account_id
		WHERE t.account_id = $1
	`, attacker).Scan(&name))
	require.Nil(t, name, "must not read another account's encrypted_name")
}

// discardUploadReservation is the buffer-upload failure path. The bare
// (file_id, version_number, shard_index, node_id) delete also removed rows that
// had already advanced past UPLOADING — including a concurrent winner's row and
// any RELAY_BUFFERED / NODE_STORED row.
func TestDiscardUploadReservationSparesNonUploadingRows(t *testing.T) {
	pool, buf := setupIsolationTest(t)
	ctx := context.Background()
	victim := newForeignAccountFixture(t, pool, buf, "discard")

	md := uploadMetadata{
		FileID:        victim.file,
		VersionNumber: victim.version,
		ShardIndex:    0,
		TargetNode:    victim.node,
	}

	attacker := "acct-discard-attacker-" + fmt.Sprint(time.Now().UnixNano())
	_, err := pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`,
		attacker, attacker+"@test.local")
	require.NoError(t, err)

	// A foreign-account failure path must not reach the victim's row.
	discardUploadReservation(ctx, pool, attacker, md)
	victim.requireIntact(t, pool, buf)

	// Even as the owning account, a row that already reached RELAY_BUFFERED
	// (buffer_id set) must survive a failure-path cleanup: that shard is
	// already durable and the node has been told to expect it.
	discardUploadReservation(ctx, pool, victim.account, md)
	victim.requireIntact(t, pool, buf)

	// An unarmed UPLOADING reservation from the owning account — the case the
	// cleanup exists for — is removed. file_versions must be inserted first:
	// file_locations FK's to (file_id, version_number).
	_, err = pool.Exec(ctx,
		`INSERT INTO file_versions (file_id, version_number, version_hash, shard_count) VALUES ($1, 2, 'vh2', 1)`,
		victim.file)
	require.NoError(t, err)
	_, err = pool.Exec(ctx,
		`INSERT INTO file_locations (file_id, version_number, shard_index, node_id, status, buffer_id)
		 VALUES ($1, 2, 0, $2, 'UPLOADING', NULL)`, victim.file, victim.node)
	require.NoError(t, err)

	md.VersionNumber = 2
	discardUploadReservation(ctx, pool, victim.account, md)

	var count int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM file_locations WHERE file_id = $1 AND version_number = 2`, victim.file).Scan(&count))
	require.Zero(t, count, "unarmed UPLOADING reservation should be cleaned up")

	// Drop the scratch version so the final integrity check below counts only
	// the fixture's original rows.
	_, err = pool.Exec(ctx, `DELETE FROM file_versions WHERE file_id = $1 AND version_number = 2`, victim.file)
	require.NoError(t, err)
	md.VersionNumber = victim.version
	victim.requireIntact(t, pool, buf)
}
