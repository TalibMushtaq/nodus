package handler

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/testutil"
)

// TestApplyDeviceBatchConcurrentMultiDeviceStress drives many devices through
// their own event sequences at once against one file-backed SQLite database,
// then asserts the final state is exactly what a serial run would produce:
// every event applied once, one file per event, and each device's cursor at its
// final sequence. Run with -race to catch shared-state corruption.
func TestApplyDeviceBatchConcurrentMultiDeviceStress(t *testing.T) {
	pool, ctx := testutil.OpenTestDB(t)

	const (
		devices      = 8
		eventsPerDev = 12
	)
	account := fmt.Sprintf("acct-stress-%d", time.Now().UnixNano())
	_, err := pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)`,
		account, account+"@test.local", "h", 0)
	require.NoError(t, err)

	var wg sync.WaitGroup
	results := make([][]bool, devices)
	for d := 0; d < devices; d++ {
		results[d] = make([]bool, eventsPerDev)
		device := fmt.Sprintf("device-%s-%d", account, d)
		wg.Add(1)
		go func(d int, device string) {
			defer wg.Done()
			for seq := 1; seq <= eventsPerDev; seq++ {
				fileID := fmt.Sprintf("file-%s-%d", device, seq)
				ev := SyncEventItem{
					EventID:        fmt.Sprintf("evt-%s-%d", device, seq),
					OriginID:       device,
					OriginSequence: int64(seq),
					Type:           "FILE_CREATED",
					Payload:        []byte(fmt.Sprintf(`{"file_id":%q}`, fileID)),
					Timestamp:      time.Now().UTC().Format(time.RFC3339),
				}
				ack := applyDeviceBatch(ctx, pool, account, device, []SyncEventItem{ev})
				results[d][seq-1] = ackOK(ack)
			}
		}(d, device)
	}
	wg.Wait()

	for d := 0; d < devices; d++ {
		for seq := 0; seq < eventsPerDev; seq++ {
			require.Truef(t, results[d][seq], "device %d event %d must apply", d, seq+1)
		}
	}

	var files, events int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM files WHERE account_id = $1`, account).Scan(&files))
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM sync_events WHERE account_id = $1`, account).Scan(&events))
	require.Equal(t, devices*eventsPerDev, files, "one file per applied event, no duplicates")
	require.Equal(t, devices*eventsPerDev, events, "one journal row per applied event, no duplicates")

	for d := 0; d < devices; d++ {
		device := fmt.Sprintf("device-%s-%d", account, d)
		var cursor int64
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT last_sequence FROM sync_cursors WHERE account_id = $1 AND peer_id = $2`, account, device).Scan(&cursor))
		require.Equal(t, int64(eventsPerDev), cursor, "each device cursor must land on its final sequence")
	}
}
