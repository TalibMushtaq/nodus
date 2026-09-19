package handler

import (
	"net/http"
	"strconv"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

// ActivityResponse is one entry in the account-wide activity feed. The shape is
// the shared protocol `ActivityRecord`: both the Relay and the Storage Node
// serve it. There is deliberately no file name — names are end-to-end encrypted
// and the Relay must never see them; `FileID` lets a client resolve the display
// name from its own decrypted catalog.
type ActivityResponse struct {
	ActivityID string    `json:"activity_id"`
	Kind       string    `json:"kind"`
	Outcome    string    `json:"outcome"`
	FileID     *string   `json:"file_id"`
	Path       *string   `json:"path"`
	Detail     *string   `json:"detail"`
	CreatedAt  time.Time `json:"created_at"`
	DeviceID   string    `json:"device_id"`
}

// activityList is the response body (`{ "activities": [...] }`).
type activityList struct {
	Activities []ActivityResponse `json:"activities"`
}

const (
	activityDefaultLimit = 200
	activityMaxLimit     = 500
)

// ListActivities returns the account's activity feed, newest first. The feed is
// projected into the `activities` table from ACTIVITY_LOGGED events (live) and
// restored from a Node snapshot (rebuild), so it survives a Relay rebuild.
// Account scoping is enforced by the WHERE clause.
func ListActivities(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		limit := activityDefaultLimit
		if raw := r.URL.Query().Get("limit"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				limit = parsed
				if limit > activityMaxLimit {
					limit = activityMaxLimit
				}
			}
		}

		rows, err := pool.Query(r.Context(), `
			SELECT activity_id, kind, outcome, file_id, path, detail, created_at, origin_id
			FROM activities
			WHERE account_id = $1
			ORDER BY created_at DESC
			LIMIT $2
		`, accountID, limit)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to query activities")
			return
		}
		defer rows.Close()

		activities := make([]ActivityResponse, 0)
		for rows.Next() {
			var a ActivityResponse
			if err := rows.Scan(
				&a.ActivityID, &a.Kind, &a.Outcome, &a.FileID, &a.Path, &a.Detail, &a.CreatedAt, &a.DeviceID,
			); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to scan activity")
				return
			}
			activities = append(activities, a)
		}
		if err := rows.Err(); err != nil {
			respondError(w, http.StatusInternalServerError, "failed to read activities")
			return
		}

		respondJSON(w, http.StatusOK, activityList{Activities: activities})
	}
}
