package auth_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
)

// fakeStore is a scriptable SessionStore used to unit-test RequireAuth without
// a live PostgreSQL.
type fakeStore struct {
	sess        *auth.Session
	err         error
	touchCount  int
	touchedWith string
}

func (f *fakeStore) CreateSession(ctx context.Context, accountID, deviceID string) (string, error) {
	return "", errors.New("not used in middleware test")
}
func (f *fakeStore) LookupSession(ctx context.Context, rawID string) (*auth.Session, error) {
	return f.sess, f.err
}
func (f *fakeStore) TouchSession(ctx context.Context, rawID string) error {
	f.touchCount++
	f.touchedWith = rawID
	return nil
}
func (f *fakeStore) RevokeSession(ctx context.Context, rawID string) error {
	return nil
}
func (f *fakeStore) RevokeAllForAccount(ctx context.Context, accountID string) error {
	return nil
}
func (f *fakeStore) RevokeAllForDevice(ctx context.Context, deviceID string) error {
	return nil
}
func (f *fakeStore) RotateSession(ctx context.Context, oldRawID, accountID, deviceID string) (string, error) {
	return "", errors.New("not used in middleware test")
}

const (
	testCookieName = "nodus_session"
	rawSession     = "session-raw-value-1234567890"
)

func TestRequireAuthSessionCookie(t *testing.T) {
	cfg := &config.Config{
		SessionCookieName: testCookieName,
	}

	store := &fakeStore{
		sess: &auth.Session{
			AccountID:  "acc-middleware",
			DeviceID:   "dev-middleware",
			ExpiresAt:  time.Now().UTC().Add(time.Hour),
			LastUsedAt: time.Now().UTC(),
		},
	}

	protectedHandler := auth.RequireAuth(store, cfg)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accID, accOK := auth.GetAccountID(r.Context())
		devID, devOK := auth.GetDeviceID(r.Context())
		if !accOK || !devOK || accID != "acc-middleware" || devID != "dev-middleware" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))

	// Case 1: valid session cookie
	req := httptest.NewRequest("GET", "/protected", nil)
	req.AddCookie(&http.Cookie{Name: testCookieName, Value: rawSession})
	rec := httptest.NewRecorder()
	protectedHandler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 with valid cookie, got %d", rec.Code)
	}
	if store.touchCount != 1 || store.touchedWith != rawSession {
		t.Fatalf("expected TouchSession called once with raw value, got count=%d value=%q", store.touchCount, store.touchedWith)
	}

	// Case 2: missing cookie
	reqNoAuth := httptest.NewRequest("GET", "/protected", nil)
	recNoAuth := httptest.NewRecorder()
	protectedHandler.ServeHTTP(recNoAuth, reqNoAuth)

	if recNoAuth.Code != http.StatusUnauthorized {
		t.Fatalf("expected status 401 with missing auth, got %d", recNoAuth.Code)
	}

	// Case 3: revoked/expired/unknown session resolves to ErrSessionInvalid
	store.sess = nil
	store.err = auth.ErrSessionInvalid
	reqBad := httptest.NewRequest("GET", "/protected", nil)
	reqBad.AddCookie(&http.Cookie{Name: testCookieName, Value: rawSession})
	recBad := httptest.NewRecorder()
	protectedHandler.ServeHTTP(recBad, reqBad)

	if recBad.Code != http.StatusUnauthorized {
		t.Fatalf("expected status 401 for invalid session, got %d", recBad.Code)
	}
	// Session lookup failure must not bump last_used_at.
	store.err = nil
	store.sess = nil
	before := store.touchCount
	recErr := httptest.NewRecorder()
	protectedHandler.ServeHTTP(recErr, reqBad)
	if recErr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 when session unknown to store, got %d", recErr.Code)
	}
	if store.touchCount != before {
		t.Fatalf("touch must not run for an invalid session")
	}
}
