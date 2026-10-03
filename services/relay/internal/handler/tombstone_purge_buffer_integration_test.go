package handler

import (
	"fmt"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/buffer"
	"github.com/TalibMushtaq/nodus/services/relay/internal/testutil"
	"github.com/stretchr/testify/require"
)

// A permanent purge deletes the file_locations rows that carry `buffer_id`. If
// the on-disk buffer file is not unlinked first, the TTL sweep (which only scans
// existing rows) can never find it again and the shard leaks forever. This test
// pins that the file is removed.
func TestFinalizeTombstonePurgeDeletesBufferFiles(t *testing.T) {
	pool, ctx := testutil.OpenTestDB(t)

	buf, err := buffer.New(t.TempDir())
	require.NoError(t, err)

	suffix := fmt.Sprint(time.Now().UnixNano())
	account := "acct-purge-buf-" + suffix
	file := "file-purge-buf-" + suffix
	node := "node-purge-buf-" + suffix
	bufferID := "buf-purge-" + suffix

	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, account, account+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ($1, $2, 'ab')`, node, account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, file, account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO file_versions (file_id, version_number, version_hash, shard_count) VALUES ($1, 1, 'vh', 1)`, file)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO file_locations (file_id, version_number, shard_index, node_id, status, buffer_id) VALUES ($1, 1, 0, $2, 'RELAY_BUFFERED', $3)`, file, node, bufferID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO tombstones (account_id, entity_type, entity_id, deleted_at, purge_after) VALUES ($1, 'file', $2, NOW(), now() + 7776000000)`, account, file)
	require.NoError(t, err)

	require.NoError(t, buf.Store(bufferID, []byte("encrypted shard")))
	require.True(t, buf.Exists(bufferID))

	require.NoError(t, finalizeTombstonePurge(ctx, pool, buf, account, "file", file))

	require.False(t, buf.Exists(bufferID), "buffer file must be unlinked on permanent purge")

	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM file_locations WHERE file_id = $1`, file).Scan(&count))
	require.Zero(t, count, "file_locations rows must be removed")
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM tombstones WHERE entity_id = $1`, file).Scan(&count))
	require.Zero(t, count, "tombstone must be removed")
}
