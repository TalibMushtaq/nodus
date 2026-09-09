package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"
)

type wsCookieSessionStore struct{}

func (wsCookieSessionStore) CreateSession(context.Context, string, string) (string, error) { return "", nil }
func (wsCookieSessionStore) LookupSession(_ context.Context, rawID string) (*auth.Session, error) {
	if rawID != "browser-session" {
		return nil, auth.ErrSessionInvalid
	}
	return &auth.Session{AccountID: "acct-browser", DeviceID: "device-browser"}, nil
}
func (wsCookieSessionStore) TouchSession(context.Context, string) error                  { return nil }
func (wsCookieSessionStore) RevokeSession(context.Context, string) error                 { return nil }
func (wsCookieSessionStore) RevokeAllForAccount(context.Context, string) error           { return nil }
func (wsCookieSessionStore) RevokeAllForDevice(context.Context, string) error            { return nil }
func (wsCookieSessionStore) RotateSession(context.Context, string, string, string) (string, error) {
	return "", nil
}

func TestWebSocketCookieHandshakeAuthenticatesSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h := hub.New(nil)
	go h.Run(ctx)

	cfg := &config.Config{SessionCookieName: "nodus_session"}
	server := httptest.NewServer(WebSocket(h, nil, nil, nil, wsCookieSessionStore{}, cfg))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	header := http.Header{"Cookie": {"nodus_session=browser-session"}}
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	require.NoError(t, err)
	defer conn.Close()

	// The server first sends its node challenge. Drain it before asserting that
	// the cookie-authenticated connection is routable by its account identity.
	_, _, err = conn.ReadMessage()
	require.NoError(t, err)

	h.SendToAccount("acct-browser", []byte(`{"type":"session_cookie_verified"}`))
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	_, payload, err := conn.ReadMessage()
	require.NoError(t, err)
	require.Contains(t, string(payload), "session_cookie_verified")
}
