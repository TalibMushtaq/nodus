package handler

import (
	"fmt"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

// Sustained Path C load: every shard of one version is uploaded concurrently
// and must land as RELAY_BUFFERED with no loss or corruption of the shard
// status rows. Integration-only — `setupBufferHarness` skips unless
// TEST_DATABASE_URL is set (TS and Postgres are the real dependencies under
// load, so a mock would not exercise anything meaningful).
func TestBufferUploadSustainedLoad(t *testing.T) {
	h := setupBufferHarness(t)

	const shards = 50
	const version = 2

	// A version row with many shards; the upload handler validates the shard
	// index against it, so the load needs a matching shard_count.
	_, err := h.pool.Exec(h.ctx,
		`INSERT INTO file_versions (file_id, version_number, conflict_status, version_hash, shard_count, created_at)
		 VALUES ($1, $2, 'none', 'vhash-load', $3, NOW()) ON CONFLICT DO NOTHING`,
		h.fileID, version, shards)
	require.NoError(t, err)

	var wg sync.WaitGroup
	failures := make(chan error, shards)
	for i := 0; i < shards; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			body := []byte(fmt.Sprintf("encrypted-shard-%d", idx))
			md := uploadMetadata{
				FileID:        h.fileID,
				VersionNumber: version,
				ShardIndex:    idx,
				Size:          int64(len(body)),
				TransferID:    fmt.Sprintf("load-%d", idx),
				TargetNode:    h.nodeID,
				SourceDevice:  "dev-load",
			}
			if rr := h.uploadShard(t, md, body, ""); rr.Code != 201 {
				failures <- fmt.Errorf("shard %d: HTTP %d: %s", idx, rr.Code, rr.Body.String())
			}
		}(i)
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}

	for i := 0; i < shards; i++ {
		require.Equal(t, "RELAY_BUFFERED", h.shardStatus(t, h.fileID, version, i))
	}
}
