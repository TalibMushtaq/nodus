package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
)

// getAuth issues an authenticated GET for accountID against a handler.
func getAuth(t *testing.T, handler http.HandlerFunc, accountID, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, accountID))
	rr := httptest.NewRecorder()
	handler(rr, req)
	return rr
}

// EnvelopeSummary must aggregate file + folder coverage per recipient and stay
// account-scoped, since Security renders its counts directly.
func TestEnvelopeSummaryCountsPerRecipient(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	ctx := context.Background()

	pfx := accountID[:8] // unique per test for id columns
	_, err := pool.Exec(ctx, fmt.Sprintf(`
		INSERT INTO files (file_id, account_id, encrypted_name)
		VALUES ('f1-%s', $1, 'x'), ('f2-%s', $1, 'y')
	`, pfx, pfx), accountID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, fmt.Sprintf(`
		INSERT INTO folders (folder_id, account_id, encrypted_name)
		VALUES ('dir1-%s', $1, 'z')
	`, pfx), accountID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, fmt.Sprintf(`
		INSERT INTO key_envelopes (file_id, recipient_id, recipient_kind, encrypted_key) VALUES
			('f1-%s', 'dev-1', 'device', 'k1'),
			('f2-%s', 'dev-1', 'device', 'k2'),
			('f1-%s', 'node-1', 'node', 'k3')
	`, pfx, pfx, pfx))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, fmt.Sprintf(`
		INSERT INTO folder_key_envelopes (folder_id, recipient_id, recipient_kind, encrypted_key) VALUES
			('dir1-%s', 'dev-1', 'device', 'k4')
	`, pfx))
	require.NoError(t, err)

	rr := getAuth(t, EnvelopeSummary(pool), accountID, "/envelopes/summary")
	require.Equal(t, http.StatusOK, rr.Code)

	var summaries []EnvelopeSummaryResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &summaries))
	require.Len(t, summaries, 2)
	// Ordered by kind then recipient: device before node.
	require.Equal(t, "dev-1", summaries[0].RecipientID)
	require.Equal(t, 2, summaries[0].FileCount)
	require.Equal(t, 1, summaries[0].FolderCount)
	require.NotNil(t, summaries[0].LastUpdated)
	require.Equal(t, "node-1", summaries[1].RecipientID)
	require.Equal(t, 1, summaries[1].FileCount)
	require.Equal(t, 0, summaries[1].FolderCount)
}

// Export must return both envelope families for the account.
func TestExportEnvelopesReturnsBothFamilies(t *testing.T) {
	pool, accountID := createPairingCodeHarness(t)
	ctx := context.Background()

	pfx := accountID[:8]
	_, err := pool.Exec(ctx, fmt.Sprintf(`INSERT INTO files (file_id, account_id, encrypted_name) VALUES ('f1-%s', $1, 'x')`, pfx), accountID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, fmt.Sprintf(`INSERT INTO folders (folder_id, account_id, encrypted_name) VALUES ('dir1-%s', $1, 'z')`, pfx), accountID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, fmt.Sprintf(`INSERT INTO key_envelopes (file_id, recipient_id, recipient_kind, encrypted_key) VALUES ('f1-%s', 'dev-1', 'device', 'k1')`, pfx))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, fmt.Sprintf(`INSERT INTO folder_key_envelopes (folder_id, recipient_id, recipient_kind, encrypted_key) VALUES ('dir1-%s', 'dev-1', 'device', 'k2')`, pfx))
	require.NoError(t, err)

	rr := getAuth(t, ExportEnvelopes(pool), accountID, "/envelopes/export")
	require.Equal(t, http.StatusOK, rr.Code)

	var backup EnvelopeExportResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &backup))
	require.Equal(t, accountID, backup.AccountID)
	require.Len(t, backup.FileEnvelopes, 1)
	require.Len(t, backup.FolderEnvelopes, 1)
}
