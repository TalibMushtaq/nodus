package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/testutil"
	"github.com/stretchr/testify/require"
)

// An ACTIVITY_LOGGED event must project into the account's feed and be returned
// by GET /activities, attributed to the origin device.
func TestActivityLoggedProjectsAndLists(t *testing.T) {
	pool, ctx := testutil.OpenTestDB(t)
	var err error

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
