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

// TestApplyDeviceBatchFileVersionAnnounce is a regression test for the Phase 14
// upload announce path. It reproduces exactly the events a web uploader sends
// when it puts a new file into a folder: [FILE_CREATED, FILE_VERSION_ADDED].
//
// Regression: `file_versions` has no row for a fresh version, and pgx wraps its
// no-rows sentinel (pgx.ErrNoRows is a *proxyError around sql.ErrNoRows), so a
// `switch err; err == sql.ErrNoRows` occupancy check never matched a vacant slot
// and every announce batch was rejected wholesale with reason "rejected".
// Fixed by switching the check to errors.Is(err, pgx.ErrNoRows).
func TestApplyDeviceBatchFileVersionAnnounce(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()

	suffix := fmt.Sprint(time.Now().UnixNano())
	folderID := "folder-" + suffix
	fileID := "file-" + suffix

	folderAck := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{{
		EventID:        "evt-folder-" + suffix,
		OriginID:       f.device,
		OriginSequence: 1,
		Type:           "FOLDER_CREATED",
		Payload:        []byte(fmt.Sprintf(`{"folder_id":%q,"parent_folder_id":null,"encrypted_name":"ZW5jLXRlc3Q="}`, folderID)),
		Timestamp:      time.Now().UTC().Format(time.RFC3339),
	}})
	require.True(t, ackOK(folderAck), "folder create should apply: %+v", folderAck)

	ack := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{
		{
			EventID:        "evt-created-" + suffix,
			OriginID:       f.device,
			OriginSequence: 2,
			Type:           "FILE_CREATED",
			Payload:        []byte(fmt.Sprintf(`{"file_id":%q,"parent_folder_id":%q,"encrypted_name":"ZW5jLXRlc3Q="}`, fileID, folderID)),
			Timestamp:      time.Now().UTC().Format(time.RFC3339),
		},
		{
			EventID:        "evt-version-" + suffix,
			OriginID:       f.device,
			OriginSequence: 3,
			Type:           "FILE_VERSION_ADDED",
			Payload:        []byte(fmt.Sprintf(`{"file_id":%q,"parent_folder_id":%q,"version_number":1,"shard_count":4,"version_hash":"deadbeef","encrypted_name":"ZW5jLXRlc3Q="}`, fileID, folderID)),
			Timestamp:      time.Now().UTC().Format(time.RFC3339),
		},
	})
	require.True(t, ackOK(ack), "fresh file announce batch must apply, got %+v", ack)
	require.Len(t, ack.AppliedEventIDs, 2)

	var versionNumber int
	require.NoError(t, f.pool.QueryRow(ctx,
		`SELECT version_number FROM file_versions WHERE file_id = $1`,
		fileID).Scan(&versionNumber))
	require.Equal(t, 1, versionNumber)
}

// TestApplySingleEventFileVersionForVacantSlotRegression is the node path twin:
// a node-originated FILE_VERSION_ADDED for a file that exists but has no
// versions yet must apply, not be dropped.
func TestApplySingleEventFileVersionForVacantSlotRegression(t *testing.T) {
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
	account := "acct-vacant-" + suffix
	fileID := "file-vacant-" + suffix
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, account, account+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, fileID, account)
	require.NoError(t, err)

	applied := applySingleEvent(ctx, pool, account, SyncEventItem{
		EventID:        "evt-vacant-" + suffix,
		OriginID:       "node-" + suffix,
		OriginSequence: 1,
		Type:           "FILE_VERSION_ADDED",
		Payload:        []byte(fmt.Sprintf(`{"file_id":%q,"version_number":1,"shard_count":2,"version_hash":"beef"}`, fileID)),
		Timestamp:      time.Now().UTC().Format(time.RFC3339),
	})
	require.True(t, applied, "a FILE_VERSION_ADDED for a file without versions must apply on the node path too")
}
