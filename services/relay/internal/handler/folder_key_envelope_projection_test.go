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

func folderKeyEnvelopeEvent(device string, seq int, folderID, recipientID, kind, encryptedKey string) SyncEventItem {
	return SyncEventItem{
		EventID:        fmt.Sprintf("evt-folderenv-%s-%d", device, seq),
		OriginID:       device,
		OriginSequence: int64(seq),
		Type:           "FOLDER_KEY_ENVELOPE_ADDED",
		Payload: []byte(fmt.Sprintf(
			`{"folder_id":%q,"recipient_id":%q,"recipient_kind":%q,"encrypted_key":%q}`,
			folderID, recipientID, kind, encryptedKey,
		)),
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
}

func TestFolderKeyEnvelopeProjectionAndRead(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()
	folderID := "folder-env-" + f.device

	// The folder must exist before its key envelope (the Relay checks folder
	// ownership and the FK requires the row).
	create := folderEvent(f.device, 1, folderID, "FOLDER_CREATED")
	envelope := folderKeyEnvelopeEvent(f.device, 2, folderID, f.device, "device", "opaque-folder-key")
	ack := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{create, envelope})
	require.True(t, ackOK(ack), "%+v", ack)

	var stored, kind string
	require.NoError(t, f.pool.QueryRow(ctx,
		`SELECT encrypted_key, recipient_kind FROM folder_key_envelopes WHERE folder_id=$1 AND recipient_id=$2`,
		folderID, f.device).Scan(&stored, &kind))
	require.Equal(t, "opaque-folder-key", stored)
	require.Equal(t, "device", kind)

	// Per-folder read.
	req := httptest.NewRequest(http.MethodGet, "/envelopes?folder_id="+folderID, nil)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, f.account))
	rr := httptest.NewRecorder()
	ListEnvelopes(f.pool)(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	require.Contains(t, rr.Body.String(), "opaque-folder-key")

	// Bulk read used by the folder tree.
	req = httptest.NewRequest(http.MethodGet, "/folder-envelopes", nil)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, f.account))
	rr = httptest.NewRecorder()
	ListFolderEnvelopes(f.pool)(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	require.Contains(t, rr.Body.String(), folderID)
}

func TestFolderKeyEnvelopeRejectsInvalidKind(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()
	folderID := "folder-env-bad-" + f.device

	create := folderEvent(f.device, 1, folderID, "FOLDER_CREATED")
	bad := folderKeyEnvelopeEvent(f.device, 2, folderID, f.device, "admin", "opaque")
	ack := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{create, bad})
	require.False(t, ackOK(ack))
	require.Equal(t, "rejected", ack.Reason)

	var count int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM folder_key_envelopes WHERE folder_id=$1`, folderID).Scan(&count))
	require.Zero(t, count, "invalid recipient_kind must not write a row")
}

func TestFolderKeyEnvelopeRejectsForeignFolder(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()

	other := "other-folderenv-" + f.device
	_, err := f.pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, other, other+"@test.local")
	require.NoError(t, err)
	foreignFolder := "folder-foreign-env-" + f.device
	_, err = f.pool.Exec(ctx, `INSERT INTO folders (folder_id, account_id, encrypted_name) VALUES ($1, $2, 'theirs')`, foreignFolder, other)
	require.NoError(t, err)

	envelope := folderKeyEnvelopeEvent(f.device, 1, foreignFolder, f.device, "device", "opaque")
	ack := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{envelope})
	require.False(t, ackOK(ack))
	require.Equal(t, "rejected", ack.Reason)

	var count int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM folder_key_envelopes WHERE folder_id=$1`, foreignFolder).Scan(&count))
	require.Zero(t, count)
}
