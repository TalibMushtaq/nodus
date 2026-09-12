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

func keyEnvelopeEventKind(device string, seq int, fileID, recipientID, kind, encryptedKey string) SyncEventItem {
	return SyncEventItem{
		EventID:        fmt.Sprintf("evt-env-%s-%d", device, seq),
		OriginID:       device,
		OriginSequence: int64(seq),
		Type:           "KEY_ENVELOPE_ADDED",
		Payload: []byte(fmt.Sprintf(
			`{"file_id":%q,"recipient_id":%q,"recipient_kind":%q,"encrypted_key":%q}`,
			fileID, recipientID, kind, encryptedKey,
		)),
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
}

func keyEnvelopeEvent(device string, seq int, fileID, recipientID, encryptedKey string) SyncEventItem {
	return keyEnvelopeEventKind(device, seq, fileID, recipientID, "device", encryptedKey)
}

func TestKeyEnvelopeProjectionAndRead(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()

	created, fileID := f.fileCreated(1)
	envelope := keyEnvelopeEvent(f.device, 2, fileID, f.device, "opaque-envelope")
	ack := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{created, envelope})
	require.True(t, ackOK(ack), "%+v", ack)

	var stored, kind string
	require.NoError(t, f.pool.QueryRow(ctx,
		`SELECT encrypted_key, recipient_kind FROM key_envelopes WHERE file_id=$1 AND recipient_id=$2`,
		fileID, f.device).Scan(&stored, &kind))
	require.Equal(t, "opaque-envelope", stored)
	require.Equal(t, "device", kind)

	req := httptest.NewRequest(http.MethodGet, "/envelopes?file_id="+fileID, nil)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, f.account))
	rr := httptest.NewRecorder()
	ListEnvelopes(f.pool)(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	require.Contains(t, rr.Body.String(), "opaque-envelope")
}

func TestKeyEnvelopeRejectsInvalidKind(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()

	created, fileID := f.fileCreated(1)
	bad := keyEnvelopeEventKind(f.device, 2, fileID, f.device, "admin", "opaque")
	ack := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{created, bad})
	require.False(t, ackOK(ack))
	require.Equal(t, "rejected", ack.Reason)

	var count int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM key_envelopes WHERE file_id=$1`, fileID).Scan(&count))
	require.Zero(t, count, "invalid recipient_kind must not write a row")
}

func TestKeyEnvelopeRejectsForeignFile(t *testing.T) {
	f := newDeviceBatchFixture(t)
	ctx := context.Background()

	// Seed a file owned by a different account, then try to attach an envelope.
	other := "other-env-" + f.device
	_, err := f.pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, other, other+"@test.local")
	require.NoError(t, err)
	foreignFile := "file-foreign-" + f.device
	_, err = f.pool.Exec(ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, foreignFile, other)
	require.NoError(t, err)

	envelope := keyEnvelopeEvent(f.device, 1, foreignFile, f.device, "opaque")
	ack := applyDeviceBatch(ctx, f.pool, f.account, f.device, []SyncEventItem{envelope})
	require.False(t, ackOK(ack))
	require.Equal(t, "rejected", ack.Reason)

	var count int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM key_envelopes WHERE file_id=$1`, foreignFile).Scan(&count))
	require.Zero(t, count)
}
