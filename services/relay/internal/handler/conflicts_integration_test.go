package handler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/stretchr/testify/require"
)

func TestResolveConflictMarksFlaggedVersionsResolved(t *testing.T) {
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
	account, file := "acct-conflict-"+suffix, "file-conflict-"+suffix
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, account, account+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, file, account)
	require.NoError(t, err)
	// version 1 is a flagged (conflicted) copy; version 2 is clean.
	_, err = pool.Exec(ctx, `
		INSERT INTO file_versions (file_id, version_number, conflict_status, version_hash, shard_count)
		VALUES ($1, 1, 'flagged', 'vh1', 1), ($1, 2, 'none', 'vh2', 1)
	`, file)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/files/"+file+"/conflicts/resolve", nil)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, account))
	req.SetPathValue("file_id", file)
	rr := httptest.NewRecorder()
	ResolveConflict(pool, nil)(rr, req)

	require.Equal(t, http.StatusOK, rr.Code)

	// The flagged version is resolved; the clean one is untouched.
	var flaggedStatus, cleanStatus string
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT conflict_status FROM file_versions WHERE file_id = $1 AND version_number = 1`, file).Scan(&flaggedStatus))
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT conflict_status FROM file_versions WHERE file_id = $1 AND version_number = 2`, file).Scan(&cleanStatus))
	require.Equal(t, "resolved", flaggedStatus)
	require.Equal(t, "none", cleanStatus)

	// A CONFLICT_RESOLVED event is recorded for the account so nodes catch up.
	var events int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM sync_events WHERE account_id = $1 AND event_type = 'CONFLICT_RESOLVED'`, account).Scan(&events))
	require.Equal(t, 1, events)
}
