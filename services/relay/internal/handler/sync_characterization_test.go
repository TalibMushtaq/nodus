package handler

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Characterization tests for the invariants the PostgreSQL -> SQLite migration
// must preserve. Duplicate suppression and node-batch serialization are the two
// gaps left by the existing sync tests (which already cover device concurrency,
// whole-batch rejection, and node savepoint rollback).

// Replaying an event below the stored cursor is rejected as a sequence
// regression, but it must not re-project the entity or journal a second row.
// The client recovers using LastOriginSequence. This is the observable
// duplicate-suppression contract: at-least-once delivery stays safe because the
// server cursor, not the event body, is authoritative.
func TestApplyDeviceBatchReplayBelowCursorDoesNotDuplicate(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()

	ev, fileID := f.fileCreated(1)
	first := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{ev})
	require.True(t, ackOK(first), "first apply should succeed: %+v", first)

	replay := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{ev})
	require.False(t, ackOK(replay), "replay below the cursor is a regression: %+v", replay)
	require.Equal(t, "sequence_regression", replay.Reason)
	require.NotNil(t, replay.LastOriginSequence)
	require.Equal(t, int64(1), *replay.LastOriginSequence)

	var files int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM files WHERE file_id = $1`, fileID).Scan(&files))
	require.Equal(t, 1, files, "duplicate replay must not project a second file row")

	var events int
	require.NoError(t, f.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sync_events WHERE account_id = $1 AND event_id = $2`, f.account, ev.EventID).Scan(&events))
	require.Equal(t, 1, events, "duplicate replay must not journal a second event row")
}

// The idempotency check guards event-id reuse: an event whose event_id was
// already journaled is acknowledged (so the batch does not wedge) but is never
// re-projected, even when it arrives under a fresh, valid origin sequence.
func TestApplyDeviceBatchReusedEventIDDoesNotReproject(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()

	ev, fileID := f.fileCreated(1)
	require.True(t, ackOK(applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{ev})))

	// Same event_id, new sequence: passes pre-validation, caught by the
	// per-event idempotency check instead.
	reused := ev
	reused.OriginSequence = 2
	ack := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{reused})
	require.True(t, ackOK(ack), "event-id reuse must be acknowledged, not rejected: %+v", ack)

	var files int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM files WHERE file_id = $1`, fileID).Scan(&files))
	require.Equal(t, 1, files, "reused event_id must not re-project the file")

	var events int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM sync_events WHERE account_id = $1`, f.account).Scan(&events))
	require.Equal(t, 1, events, "reused event_id must not journal a second row")
}

// Node batches use a savepoint per event; the same replay contract holds.
func TestApplyNodeBatchReplayBelowCursorDoesNotDuplicate(t *testing.T) {
	ctx, pool, account, node, file := nodeBatchFixture(t)

	ev := shardStoredEvent("evt-node-dup", node, file, 1)
	first := applyNodeBatch(ctx, pool, account, node, []SyncEventItem{ev})
	require.True(t, ackOK(first), "first node apply should succeed: %+v", first)

	replay := applyNodeBatch(ctx, pool, account, node, []SyncEventItem{ev})
	require.False(t, ackOK(replay), "replay below the cursor is a regression: %+v", replay)
	require.Equal(t, "sequence_regression", replay.Reason)

	require.Equal(t, 1, journaledCount(t, ctx, pool, account),
		"duplicate replay must not journal a second node event row")
}

// Without the cursor lock (FOR UPDATE on PostgreSQL, the immediate write
// transaction on SQLite) two concurrent node batches could both read last=0 and
// both acknowledge. Exactly one may advance the cursor.
func TestApplyNodeBatchConcurrentBatchesSerialize(t *testing.T) {
	ctx, pool, account, node, file := nodeBatchFixture(t)

	seed := shardStoredEvent("evt-node-seed", node, file, 1)
	require.True(t, ackOK(applyNodeBatch(ctx, pool, account, node, []SyncEventItem{seed})))

	// Two different shards of the same file at the same origin sequence: both
	// are otherwise valid, so only the cursor lock decides the winner.
	build := func(eventID string, shardIndex int) SyncEventItem {
		payload, _ := json.Marshal(map[string]any{
			"file_id": file, "version_number": 1, "shard_index": shardIndex,
			"hash": "h", "size_bytes": 1234,
		})
		return SyncEventItem{
			EventID: eventID, OriginID: node, OriginSequence: 2,
			Type: "FILE_SHARD_STORED", Payload: payload,
			Timestamp: time.Now().UTC().Format(time.RFC3339),
		}
	}

	var (
		wg   sync.WaitGroup
		acks [2]BatchAckPayload
	)
	for i, ev := range []SyncEventItem{build("evt-node-a", 0), build("evt-node-b", 1)} {
		wg.Add(1)
		go func(idx int, item SyncEventItem) {
			defer wg.Done()
			acks[idx] = applyNodeBatch(ctx, pool, account, node, []SyncEventItem{item})
		}(i, ev)
	}
	wg.Wait()

	oks := 0
	for _, ack := range acks {
		if ackOK(ack) {
			oks++
		} else {
			require.Equal(t, "sequence_regression", ack.Reason)
		}
	}
	require.Equal(t, 1, oks, "exactly one concurrent node batch may advance the cursor")

	var cursor int64
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT last_sequence FROM sync_cursors WHERE account_id = $1 AND peer_id = $2`, account, node).Scan(&cursor))
	require.Equal(t, int64(2), cursor)
}

// A cursor row is created before the lock is taken, so the first-ever batch for
// a peer serializes against a second concurrent first batch instead of both
// racing on an absent row.
func TestApplyDeviceBatchConcurrentFirstBatchesCreateCursorOnce(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()

	evA, _ := f.fileCreated(1)
	evB, _ := f.fileCreated(1)
	var (
		wg   sync.WaitGroup
		acks [2]BatchAckPayload
	)
	for i, ev := range []SyncEventItem{evA, evB} {
		wg.Add(1)
		go func(idx int, item SyncEventItem) {
			defer wg.Done()
			acks[idx] = applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{item})
		}(i, ev)
	}
	wg.Wait()

	oks := 0
	for _, ack := range acks {
		if ackOK(ack) {
			oks++
		}
	}
	require.Equal(t, 1, oks, "exactly one concurrent first batch may apply")

	var cursors int
	require.NoError(t, f.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sync_cursors WHERE account_id = $1 AND peer_id = $2`, f.account, f.device).Scan(&cursors))
	require.Equal(t, 1, cursors, "the cursor upsert must leave exactly one row")
}
