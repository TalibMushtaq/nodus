package handler

import (
	"context"
	"encoding/json"
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

func TestListFilesReturnsVersionsAndLocations(t *testing.T) {
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
	account, node, file := "acct-files-"+suffix, "node-files-"+suffix, "file-files-"+suffix
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, account, account+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ($1, $2, 'ab')`, node, account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id, encrypted_name) VALUES ($1, $2, 'v1.aabb.cc')`, file, account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO file_versions (file_id, version_number, version_hash, shard_count) VALUES ($1, 1, 'vh', 2)`, file)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO file_locations (file_id, version_number, shard_index, node_id, status) VALUES ($1, 1, 0, $2, 'NODE_STORED'), ($1, 1, 1, $2, 'RELAY_BUFFERED')`, file, node)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodGet, "/files", nil)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, account))
	rr := httptest.NewRecorder()
	ListFiles(pool)(rr, req)

	require.Equal(t, http.StatusOK, rr.Code)
	var files []FileResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &files))
	require.Len(t, files, 1)
	require.Equal(t, file, files[0].FileID)
	require.Len(t, files[0].Versions, 1)
	require.Equal(t, 2, files[0].Versions[0].ShardCount)
	require.Len(t, files[0].Locations, 2)
	require.Equal(t, "NODE_STORED", files[0].Locations[0].Status)
}

func TestListFilesRejectsUnauthenticated(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/files", nil)
	rr := httptest.NewRecorder()
	ListFiles(nil)(rr, req)
	require.Equal(t, http.StatusUnauthorized, rr.Code)
}
