package handler

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/stretchr/testify/require"
)

func TestDeviceAllowedEventType(t *testing.T) {
	allowed := []string{
		"FILE_CREATED", "FILE_VERSION_ADDED", "FILE_MODIFIED", "FILE_DELETED",
		"FOLDER_CREATED", "FOLDER_DELETED", "TOMBSTONE_CREATED", "KEY_ENVELOPE_ADDED",
	}
	for _, typ := range allowed {
		require.Truef(t, deviceAllowedEventType(typ), "%s should be device-allowed", typ)
	}
	// Server-only types must stay off the device surface.
	for _, typ := range []string{"DEVICE_REVOKED", "sync_hello", ""} {
		require.Falsef(t, deviceAllowedEventType(typ), "%s should not be device-allowed", typ)
	}
}

// deviceBatchFixture wires a scratch account and returns a helper that builds a
// FILE_CREATED event for it. Kept local to this file so the integration tests
// don't depend on the shared ingestion harness.
type deviceBatchFixture struct {
	pool     *db.Pool
	account  string
	device   string
	nextFile int
}

func newDeviceBatchFixture(t *testing.T) *deviceBatchFixture {
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

	suffix := fmt.Sprint(time.Now().UnixNano())
	account := "acct-dev-" + suffix
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, account, account+"@test.local")
	require.NoError(t, err)
	return &deviceBatchFixture{pool: pool, account: account, device: "device-" + suffix}
}

func (f *deviceBatchFixture) fileCreated(seq int) (SyncEventItem, string) {
	f.nextFile++
	fileID := fmt.Sprintf("file-%s-%d", f.device, f.nextFile)
	payload := []byte(fmt.Sprintf(`{"file_id":%q}`, fileID))
	return SyncEventItem{
		EventID:        fmt.Sprintf("evt-%s-%d", f.device, seq),
		OriginID:       f.device,
		OriginSequence: int64(seq),
		Type:           "FILE_CREATED",
		Payload:        payload,
		Timestamp:      time.Now().UTC().Format(time.RFC3339),
	}, fileID
}

func ackOK(ack BatchAckPayload) bool { return ack.OK != nil && *ack.OK }

func TestApplyDeviceBatchHappyAndRegression(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()

	first, fileA := f.fileCreated(1)
	second, _ := f.fileCreated(2)
	ack := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{first, second})
	require.True(t, ackOK(ack), "valid contiguous batch should apply: %+v", ack)
	require.Len(t, ack.AppliedEventIDs, 2)
	require.NotNil(t, ack.LastOriginSequence)
	require.Equal(t, int64(2), *ack.LastOriginSequence)

	var fileCount int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM files WHERE file_id = $1`, fileA).Scan(&fileCount))
	require.Equal(t, 1, fileCount)

	// Replay of a lower sequence must be rejected with the server cursor and
	// must not move it.
	regress, _ := f.fileCreated(2)
	ack = applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{regress})
	require.False(t, ackOK(ack))
	require.Equal(t, "sequence_regression", ack.Reason)
	require.NotNil(t, ack.LastOriginSequence)
	require.Equal(t, int64(2), *ack.LastOriginSequence)
}

func TestApplyDeviceBatchRejectsWholeBatchWithoutPartialApply(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()

	// Seed cursor at 2.
	a, _ := f.fileCreated(1)
	b, _ := f.fileCreated(2)
	require.True(t, ackOK(applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{a, b})))

	// A batch whose second item regresses: the first item must not be applied.
	valid, validFile := f.fileCreated(3)
	regress, _ := f.fileCreated(2)
	ack := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{valid, regress})
	require.False(t, ackOK(ack))
	require.Equal(t, "sequence_regression", ack.Reason)

	var count int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM files WHERE file_id = $1`, validFile).Scan(&count))
	require.Zero(t, count, "rejected batch must not partially apply earlier items")

	// Cursor must be unchanged.
	var cursor int64
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT last_sequence FROM sync_cursors WHERE account_id=$1 AND peer_id=$2`, f.account, f.device).Scan(&cursor))
	require.Equal(t, int64(2), cursor)
}

func TestApplyDeviceBatchOriginAndTypeGuards(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()

	spoof, _ := f.fileCreated(1)
	spoof.OriginID = "some-other-device"
	ack := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{spoof})
	require.False(t, ackOK(ack))
	require.Equal(t, "origin_mismatch", ack.Reason)

	bad, _ := f.fileCreated(1)
	bad.Type = "DEVICE_REVOKED"
	ack = applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{bad})
	require.False(t, ackOK(ack))
	require.Equal(t, "event_type_not_allowed", ack.Reason)
}

func TestApplyDeviceBatchConcurrentBatchesSerialize(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()

	// Seed the cursor so both racers target the same next sequence. Without the
	// FOR UPDATE lock both could read last=0 and both ack ok.
	seed, _ := f.fileCreated(1)
	require.True(t, ackOK(applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{seed})))

	evA, _ := f.fileCreated(2)
	evB, _ := f.fileCreated(2) // same sequence, different event/file
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
		} else {
			require.Equal(t, "sequence_regression", ack.Reason)
		}
	}
	require.Equal(t, 1, oks, "exactly one concurrent batch may advance the cursor")
}
