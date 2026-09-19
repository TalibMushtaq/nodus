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

// An ACTIVITY_LOGGED event must project into the account's feed and be returned
// by GET /activities, attributed to the origin device.
func TestActivityLoggedProjectsAndLists(t *testing.T) {
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
	account := "acct-act-" + suffix
	device := "dev-act-" + suffix
	_, err = pool.Exec(ctx, `INSERT INTO accounts (account_id, email, password_hash) VALUES ($1, $2, 'hash')`, account, account+"@test.local")
	require.NoError(t, err)

	payload, err := json.Marshal(map[string]any{
		"activity_id": "act-" + suffix,
		"kind":        "upload",
		"outcome":     "complete",
		"file_id":     nil,
		"path":        "local",
		"detail":      "2 shards",
		"created_at":  "2026-09-19T10:00:00Z",
	})
	require.NoError(t, err)
	item := SyncEventItem{
		EventID:        "ev-" + suffix,
		OriginID:       device,
		OriginSequence: 1,
		Type:           "ACTIVITY_LOGGED",
		Payload:        json.RawMessage(payload),
		Timestamp:      "2026-09-19T10:00:00Z",
	}
	require.True(t, applySingleEvent(ctx, pool, account, item))

	req := httptest.NewRequest(http.MethodGet, "/activities", nil)
	req = req.WithContext(context.WithValue(req.Context(), auth.AccountIDKey, account))
	rr := httptest.NewRecorder()
	ListActivities(pool)(rr, req)

	require.Equal(t, http.StatusOK, rr.Code)
	var body activityList
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &body))
	require.Len(t, body.Activities, 1)
	require.Equal(t, "act-"+suffix, body.Activities[0].ActivityID)
	require.Equal(t, device, body.Activities[0].DeviceID)
	require.Equal(t, "upload", body.Activities[0].Kind)
	require.Equal(t, "complete", body.Activities[0].Outcome)
}

func TestListActivitiesRejectsUnauthenticated(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/activities", nil)
	rr := httptest.NewRecorder()
	ListActivities(nil)(rr, req)
	require.Equal(t, http.StatusUnauthorized, rr.Code)
}
