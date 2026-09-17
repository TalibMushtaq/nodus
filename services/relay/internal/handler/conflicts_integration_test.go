package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
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

// A keep_version choice records the file's preferred version and is carried on
// the emitted event, while both sides of the conflict are still acknowledged.
func TestResolveConflictRecordsPreferredVersion(t *testing.T) {
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
	account, file := "acct-keep-"+suffix, "file-keep-"+suffix
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, account, account+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, file, account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO file_versions (file_id, version_number, conflict_status, version_hash, shard_count)
		VALUES ($1, 1, 'flagged', 'vh1', 1), ($1, 2, 'flagged', 'vh2', 1)
	`, file)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/files/"+file+"/conflicts/resolve",
		strings.NewReader(`{"keep_version":1}`))
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, account))
	req.SetPathValue("file_id", file)
	rr := httptest.NewRecorder()
	ResolveConflict(pool, nil)(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)

	var preferred *int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT preferred_version FROM files WHERE file_id = $1`, file).Scan(&preferred))
	require.NotNil(t, preferred)
	require.Equal(t, 1, *preferred)

	// Both branches are acknowledged, not deleted.
	var stillFlagged int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM file_versions WHERE file_id = $1 AND conflict_status = 'flagged'`, file).Scan(&stillFlagged))
	require.Equal(t, 0, stillFlagged)

	// The recorded event carries the choice for offline nodes.
	var raw []byte
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT payload FROM sync_events WHERE account_id = $1 AND event_type = 'CONFLICT_RESOLVED'`, account).Scan(&raw))
	var payload struct {
		FileID      string `json:"file_id"`
		KeepVersion *int   `json:"keep_version"`
	}
	require.NoError(t, json.Unmarshal(raw, &payload))
	require.Equal(t, file, payload.FileID)
	require.NotNil(t, payload.KeepVersion)
	require.Equal(t, 1, *payload.KeepVersion)
}

// A keep_version that is not a version of the caller's file is rejected and
// changes nothing.
func TestResolveConflictRejectsUnknownVersion(t *testing.T) {
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
	account, file := "acct-badkeep-"+suffix, "file-badkeep-"+suffix
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, account, account+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, file, account)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO file_versions (file_id, version_number, conflict_status, version_hash, shard_count)
		VALUES ($1, 1, 'flagged', 'vh1', 1)
	`, file)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/files/"+file+"/conflicts/resolve",
		strings.NewReader(`{"keep_version":99}`))
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, account))
	req.SetPathValue("file_id", file)
	rr := httptest.NewRecorder()
	ResolveConflict(pool, nil)(rr, req)
	require.Equal(t, http.StatusBadRequest, rr.Code)

	var preferred *int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT preferred_version FROM files WHERE file_id = $1`, file).Scan(&preferred))
	require.Nil(t, preferred)
}

func TestPendingPurgesForNode(t *testing.T) {
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
	account, node := "acct-pp-"+suffix, "node-pp-"+suffix
	purging, retained := "file-purging-"+suffix, "file-retained-"+suffix
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, account, account+"@test.local")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO storage_nodes (node_id, account_id, public_key) VALUES ($1, $2, 'ab')`, node, account)
	require.NoError(t, err)
	for _, file := range []string{purging, retained} {
		_, err = pool.Exec(ctx, `INSERT INTO files (file_id, account_id) VALUES ($1, $2)`, file, account)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO file_versions (file_id, version_number, version_hash, shard_count) VALUES ($1, 1, 'vh', 1)`, file)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO file_locations (file_id, version_number, shard_index, node_id, status) VALUES ($1, 1, 0, $2, 'NODE_STORED')`, file, node)
		require.NoError(t, err)
	}
	// `purging` has a requested purge; `retained` is a plain soft delete.
	_, err = pool.Exec(ctx, `
		INSERT INTO tombstones (account_id, entity_type, entity_id, deleted_at, purge_after, purge_requested_at)
		VALUES ($1, 'file', $2, NOW(), NOW() + INTERVAL '90 days', NOW()),
		       ($1, 'file', $3, NOW(), NOW() + INTERVAL '90 days', NULL)
	`, account, purging, retained)
	require.NoError(t, err)

	// A folder with a requested purge is delivered to every active node, since
	// folders have no per-node location table.
	folder := "folder-purging-" + suffix
	_, err = pool.Exec(ctx, `
		INSERT INTO tombstones (account_id, entity_type, entity_id, deleted_at, purge_after, purge_requested_at)
		VALUES ($1, 'folder', $2, NOW(), NOW() + INTERVAL '90 days', NOW())
	`, account, folder)
	require.NoError(t, err)

	entities, err := pendingPurgesForNode(ctx, pool, account, node)
	require.NoError(t, err)
	require.Len(t, entities, 2)
	byType := map[string]string{}
	for _, e := range entities {
		byType[e.EntityType] = e.EntityID
	}
	require.Equal(t, purging, byType["file"])
	require.Equal(t, folder, byType["folder"])

	// The relay asks the active node to purge the folder too.
	nodes, err := owningNodes(ctx, pool, account, "folder", folder)
	require.NoError(t, err)
	require.Contains(t, nodes, node)
}
