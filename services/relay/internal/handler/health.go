package handler

import (
	"context"
	"net/http"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/rdb"
)

type HealthResponse struct {
	Status    string            `json:"status"`
	Timestamp time.Time         `json:"timestamp"`
	Services  map[string]string `json:"services"`
}

// Health checks the connectivity of PostgreSQL and Redis.
func Health(pool *db.Pool, redisClient *rdb.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()

		services := make(map[string]string)
		allOK := true

		// Check PostgreSQL
		if pool != nil {
			if err := pool.Ping(ctx); err != nil {
				services["postgres"] = "unhealthy: " + err.Error()
				allOK = false
			} else {
				services["postgres"] = "healthy"
			}
		} else {
			services["postgres"] = "not configured"
		}

		// Check Redis
		if redisClient != nil {
			if err := redisClient.Ping(ctx).Err(); err != nil {
				services["redis"] = "unhealthy: " + err.Error()
				allOK = false
			} else {
				services["redis"] = "healthy"
			}
		} else {
			services["redis"] = "not configured"
		}

		status := "ok"
		statusCode := http.StatusOK
		if !allOK {
			status = "degraded"
			statusCode = http.StatusServiceUnavailable
		}

		respondJSON(w, statusCode, HealthResponse{
			Status:    status,
			Timestamp: time.Now().UTC(),
			Services:  services,
		})
	}
}
