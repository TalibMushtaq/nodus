package handler

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/stretchr/testify/require"
)

func TestApplySingleEventForeignFileDoesNotJournalEvent(t *testing.T) {
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
	ownerID, senderID, fileID, eventID := "owner-"+suffix, "sender-"+suffix, "file-"+suffix, "event-"+suffix
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash'), ($3, $4, 'hash')`, ownerID, ownerID+"@test.local", senderID, senderID+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, fileID, ownerID)
	require.NoError(t, err)

	payload := []byte(fmt.Sprintf(`{"file_id":%q,"version_number":1,"version_hash":"hash","shard_count":1}`, fileID))
	applied := applySingleEvent(ctx, pool, senderID, SyncEventItem{
		EventID: eventID, OriginID: "origin-" + suffix, OriginSequence: 1,
		Type: "FILE_VERSION_ADDED", Payload: payload, Timestamp: time.Now().UTC().Format(time.RFC3339),
	})
	require.False(t, applied)

	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM sync_events WHERE event_id = $1`, eventID).Scan(&count))
	require.Zero(t, count, "foreign-file rejection must not leave an idempotency record")
}
