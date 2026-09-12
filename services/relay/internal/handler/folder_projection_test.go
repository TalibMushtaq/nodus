package handler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/stretchr/testify/require"
)

func folderEvent(device string, seq int, folderID, typ string) SyncEventItem {
	payload := []byte(fmt.Sprintf(`{"folder_id":%q,"encrypted_name":"enc"}`, folderID))
	if typ == "FOLDER_DELETED" {
		payload = []byte(fmt.Sprintf(`{"folder_id":%q}`, folderID))
	}
	return SyncEventItem{
		EventID:        fmt.Sprintf("evt-folder-%s-%d", device, seq),
		OriginID:       device,
		OriginSequence: int64(seq),
		Type:           typ,
		Payload:        payload,
		Timestamp:      time.Now().UTC().Format(time.RFC3339),
	}
}

func TestFolderProjectionCreateDeleteNoResurrect(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()
	folderID := "folder-" + f.device

	ack := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{folderEvent(f.device, 1, folderID, "FOLDER_CREATED")})
	require.True(t, ackOK(ack), "%+v", ack)

	var name string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT encrypted_name FROM folders WHERE folder_id=$1 AND account_id=$2`, folderID, f.account).Scan(&name))
	require.Equal(t, "enc", name)

	// Delete writes a tombstone.
	ack = applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{folderEvent(f.device, 2, folderID, "FOLDER_DELETED")})
	require.True(t, ackOK(ack))
	var tombstone bool
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tombstones WHERE account_id=$1 AND entity_type='folder' AND entity_id=$2)`, f.account, folderID).Scan(&tombstone))
	require.True(t, tombstone)

	// A late create must not resurrect the tombstoned folder.
	_, err := f.pool.Exec(ctx, `UPDATE folders SET encrypted_name='old' WHERE folder_id=$1`, folderID)
	require.NoError(t, err)
	ack = applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{folderEvent(f.device, 3, folderID, "FOLDER_CREATED")})
	require.True(t, ackOK(ack))
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT encrypted_name FROM folders WHERE folder_id=$1`, folderID).Scan(&name))
	require.Equal(t, "old", name, "tombstoned folder must not be resurrected")
}

func TestListFoldersReturnsAccountTree(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()
	folderID := "folder-list-" + f.device
	_, err := f.pool.Exec(ctx, `INSERT INTO folders (folder_id, account_id, encrypted_name) VALUES ($1, $2, 'enc')`, folderID, f.account)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/folders", nil)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, f.account))
	rr := httptest.NewRecorder()
	ListFolders(f.pool)(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	require.Contains(t, rr.Body.String(), folderID)
}

func TestFolderProjectionRejectsForeignFolder(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()

	// Another account owns this folder id.
	otherAccount := "other-" + f.device
	_, err := f.pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, otherAccount, otherAccount+"@test.local")
	require.NoError(t, err)
	folderID := "folder-foreign-" + f.device
	_, err = f.pool.Exec(ctx, `INSERT INTO folders (folder_id, account_id, encrypted_name) VALUES ($1, $2, 'theirs')`, folderID, otherAccount)
	require.NoError(t, err)

	ack := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{folderEvent(f.device, 1, folderID, "FOLDER_CREATED")})
	require.False(t, ackOK(ack))
	require.Equal(t, "rejected", ack.Reason)

	var name string
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT encrypted_name FROM folders WHERE folder_id=$1`, folderID).Scan(&name))
	require.Equal(t, "theirs", name)
}
