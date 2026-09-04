package handler_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/TalibMushtaq/nodus/services/relay/internal/handler"
)

func TestHealthHandlerNilServices(t *testing.T) {
	h := handler.Health(nil, nil)

	req := httptest.NewRequest("GET", "/health", nil)
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	var res handler.HealthResponse
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if res.Status != "ok" {
		t.Fatalf("expected status 'ok', got '%s'", res.Status)
	}
	if res.Services["postgres"] != "not configured" {
		t.Fatalf("expected postgres not configured, got %s", res.Services["postgres"])
	}
	if res.Services["redis"] != "not configured" {
		t.Fatalf("expected redis not configured, got %s", res.Services["redis"])
	}
}
