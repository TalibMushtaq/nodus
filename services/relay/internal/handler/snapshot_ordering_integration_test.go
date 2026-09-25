package handler

import (
	"fmt"
	"sync"
	"testing"

	"github.com/stretchr/testify/require" //nolint:depguard
)

// Two properties of the snapshot path that promotion assumed but never checked,
// because the relay kept no state to check them against.

// streamSnapshot drives a complete BEGIN + chunks + END transfer through the real
// handlers, as the primary node would, with the given snapshot sequence.
func streamSnapshot(t *testing.T, h *e2eHarness, snapshotID string, seq int64, chunks [][]byte) {
	t.Helper()
	beginHash, err := hashSnapshotRecords(chunks)
	require.NoError(t, err)

	HandleSnapshotBegin(h.ctx, h.client, mkEnv("snapshot_begin", SnapshotBeginPayload{
		SnapshotID:        snapshotID,
		NodeID:            h.client.NodeID,
		SnapshotSequence:  seq,
		TotalChunks:       int64(len(chunks)),
		ContentHash:       beginHash,
		Signature:         h.sign([]byte(beginHash)),
		DataSchemaVersion: dataSchemaVersion,
		Cursors:           []SnapshotCursor{{OriginID: "origin-e2e", Sequence: 1}},
	}), h.pool)

	if _, ok := getRebuildSession(snapshotID); !ok {
		t.Logf("snapshot %s: BEGIN was refused", snapshotID)
		return
	}
	for i, recs := range chunks {
		HandleSnapshotChunk(h.ctx, h.client, mkEnv("snapshot_chunk", SnapshotChunkPayload{
			SnapshotID: snapshotID, ChunkIndex: int64(i), RecordType: "file_version", Records: recs,
		}), h.pool)
	}
	HandleSnapshotEnd(h.ctx, h.client, mkEnv("snapshot_end", SnapshotEndPayload{
		SnapshotID: snapshotID, FinalHash: beginHash, Signature: h.sign([]byte(beginHash)),
	}), h.pool)
}

func liveFileCount(t *testing.T, h *e2eHarness, fileID string) int {
	t.Helper()
	var n int
	require.NoError(t, h.pool.QueryRow(h.ctx,
		`SELECT count(*) FROM files WHERE account_id=$1 AND file_id=$2`, h.accountID, fileID).Scan(&n))
	return n
}

// TestStaleSnapshotCannotRollBackPromotedState covers the replay of an old
// snapshot. Signature verification cannot catch it: an old snapshot is signed by
// the same key over its own content hash, so it verifies perfectly. The only
// thing distinguishing it is `snapshot_sequence`, which promotion never compared
// against anything.
//
// The damage is not a no-op: promoteRebuild deletes the account's live files and
// re-inserts from staging, so a snapshot taken before a file existed deletes that
// file. The event journal survives, but the snapshot's cursor map marks those
// events as already applied, so they are never replayed to recover it.
func TestStaleSnapshotCannotRollBackPromotedState(t *testing.T) {
	h := setupE2E(t)
	fileChunk := []byte(`[{"file_id":"ord-old-file","version_number":1,"version_hash":"h","shard_count":1}]`)

	// A snapshot at sequence 5, promoted normally.
	streamSnapshot(t, h, "snap-seq5", 5, [][]byte{fileChunk})
	require.Equal(t, 1, liveFileCount(t, h, "ord-old-file"), "the first snapshot should have been promoted")

	// The account gains a file after that snapshot was taken.
	mustExec(t, h.pool, `INSERT INTO files (file_id, account_id, encrypted_name) VALUES ('ord-new-file', $1, 'n')`, h.accountID)
	require.Equal(t, 1, liveFileCount(t, h, "ord-new-file"))

	// An older snapshot (sequence 3) that does not contain ord-new-file is replayed.
	streamSnapshot(t, h, "snap-seq3", 3, [][]byte{fileChunk})

	require.Equal(t, 1, liveFileCount(t, h, "ord-new-file"),
		"promoting an older snapshot must not delete a file the account gained after it was taken")
	require.Equal(t, 1, liveFileCount(t, h, "ord-old-file"))
}

// TestNewerSnapshotStillPromotes guards the fix against over-reach: a snapshot
// with a higher sequence must still replace the live state, which is the whole
// point of a rebuild.
func TestNewerSnapshotStillPromotes(t *testing.T) {
	h := setupE2E(t)

	streamSnapshot(t, h, "snap-a", 4, [][]byte{
		[]byte(`[{"file_id":"ord-file-a","version_number":1,"version_hash":"h","shard_count":1}]`),
	})
	require.Equal(t, 1, liveFileCount(t, h, "ord-file-a"))

	streamSnapshot(t, h, "snap-b", 9, [][]byte{
		[]byte(`[{"file_id":"ord-file-b","version_number":1,"version_hash":"h","shard_count":1}]`),
	})
	require.Equal(t, 0, liveFileCount(t, h, "ord-file-a"), "a newer snapshot replaces the previous one")
	require.Equal(t, 1, liveFileCount(t, h, "ord-file-b"))
}

// TestConcurrentSnapshotBeginIsSingleFlight covers the check-then-act gap in the
// rebuild single-flight guard. The account check and the session insert are two
// separate lock acquisitions, so two connections can both observe "no rebuild in
// flight" and both open a session.
//
// Both then stage into the same rebuild_* tables, keyed by account. Each session
// only checks its *own* chunk ordering, and END recomputes the content hash from
// its own chunk bytes, so a mixture of two different snapshots passes every
// verification and gets promoted. The loser's abort then wipes the staging
// tables out from under the winner.
func TestConcurrentSnapshotBeginIsSingleFlight(t *testing.T) {
	h := setupE2E(t)

	// Each burst deliberately leaves one session open; clear them all afterwards
	// so this test cannot block a later one through the single-flight guard.
	t.Cleanup(func() {
		rebuildSessionsMu.Lock()
		rebuildSessions = make(map[string]*rebuildSession)
		rebuildSessionsMu.Unlock()
	})

	const (
		bursts     = 25
		goroutines = 16
	)
	for burst := 0; burst < bursts; burst++ {
		// Start from a clean slate so each burst is independent.
		rebuildSessionsMu.Lock()
		rebuildSessions = make(map[string]*rebuildSession)
		rebuildSessionsMu.Unlock()

		chunk := []byte(fmt.Sprintf(
			`[{"file_id":"burst-%d","version_number":1,"version_hash":"h","shard_count":1}]`, burst))
		beginHash, err := hashSnapshotRecords([][]byte{chunk})
		require.NoError(t, err)

		var gate chan struct{} = make(chan struct{})
		var done sync.WaitGroup
		done.Add(goroutines)
		for g := 0; g < goroutines; g++ {
			go func(g int) {
				defer done.Done()
				<-gate
				HandleSnapshotBegin(h.ctx, h.client, mkEnv("snapshot_begin", SnapshotBeginPayload{
					SnapshotID:        fmt.Sprintf("burst-%d-snap-%d", burst, g),
					NodeID:            h.client.NodeID,
					SnapshotSequence:  1,
					TotalChunks:       1,
					ContentHash:       beginHash,
					Signature:         h.sign([]byte(beginHash)),
					DataSchemaVersion: dataSchemaVersion,
				}), h.pool)
			}(g)
		}
		close(gate)
		done.Wait()

		rebuildSessionsMu.Lock()
		active := 0
		for _, s := range rebuildSessions {
			if s.accountID == h.accountID && !s.failed {
				active++
			}
		}
		rebuildSessionsMu.Unlock()
		require.LessOrEqual(t, active, 1,
			"burst %d: %d concurrent snapshot_begin calls opened %d sessions for one account",
			burst, goroutines, active)
	}
}

// TestPromotedWatermarkIsAtomicWithConcurrentPromotes covers the promoted
// watermark write. The row lock taken at the top of promoteRebuild is only
// load-bearing if the new watermark is written before that lock is released.
// Writing it after the commit left a window in which a second promote read a
// stale watermark, and — when the older promote's write happened to land last —
// moved the watermark backwards, re-opening the window for a snapshot that had
// already been promoted.
//
// Concurrent entry into promoteRebuild is not hypothetical: HandleSnapshotEnd
// resolves the session by snapshot id and only removes it afterwards, so a
// duplicated snapshot_end frame promotes the same session twice at once.
//
// The assertion is order-independent. Whichever of the two promotes takes the
// lock first, the final watermark must be the higher sequence; the older
// snapshot may either be refused outright or promote first and be superseded,
// but it must never be the value left behind.
func TestPromotedWatermarkIsAtomicWithConcurrentPromotes(t *testing.T) {
	h := setupE2E(t)
	clearRebuildSessions(t)

	// Staged rows the promotes will install. Both sessions promote the same
	// account, so the staging is shared; only the sequence under test differs.
	mustExec(t, h.pool,
		`INSERT INTO rebuild_files (file_id, account_id, encrypted_name) VALUES ('wm-file', $1, 'n')`,
		h.accountID)

	newer := &rebuildSession{
		snapshotID:        "wm-newer",
		nodeID:            h.client.NodeID,
		accountID:         h.accountID,
		snapshotSequence:  7,
		dataSchemaVersion: dataSchemaVersion,
	}
	older := &rebuildSession{
		snapshotID:        "wm-older",
		nodeID:            h.client.NodeID,
		accountID:         h.accountID,
		snapshotSequence:  4,
		dataSchemaVersion: dataSchemaVersion,
	}

	for attempt := range 12 {
		// Re-stage: a successful promote clears the account's staged rows.
		mustExec(t, h.pool,
			`INSERT INTO rebuild_files (file_id, account_id, encrypted_name)
			 VALUES ('wm-file', $1, 'n') ON CONFLICT DO NOTHING`, h.accountID)

		var gate chan struct{} = make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		for _, sess := range []*rebuildSession{newer, older} {
			go func(s *rebuildSession) {
				defer wg.Done()
				<-gate
				// Either outcome is legitimate for the older snapshot; what must
				// not happen is its write winning after the newer one.
				_ = promoteRebuild(h.ctx, h.pool, s)
			}(sess)
		}
		close(gate)
		wg.Wait()

		var watermark int64
		require.NoError(t, h.pool.QueryRow(h.ctx,
			`SELECT last_promoted_snapshot_sequence FROM storage_nodes WHERE node_id = $1`,
			h.client.NodeID).Scan(&watermark))
		require.Equal(t, int64(7), watermark,
			"attempt %d: a concurrent older promote moved the watermark backwards", attempt)
	}
}

// clearRebuildSessions resets the process-wide session map so a test that calls
// promoteRebuild directly cannot leave a session behind to block the next one.
func clearRebuildSessions(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		rebuildSessionsMu.Lock()
		rebuildSessions = make(map[string]*rebuildSession)
		rebuildSessionsMu.Unlock()
	})
}
