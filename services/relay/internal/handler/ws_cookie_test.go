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

func (wsCookieSessionStore) CreateSession(context.Context, string, string) (string, error) {
	return "", nil
}
func (wsCookieSessionStore) LookupSession(_ context.Context, rawID string) (*auth.Session, error) {
	// Both credential transports (browser cookie, native bearer) resolve to
	// the same store; distinct tokens only make each test's intent legible.
	switch rawID {
	case "browser-session":
		return &auth.Session{AccountID: "acct-browser", DeviceID: "device-browser"}, nil
	case "native-session":
		return &auth.Session{AccountID: "acct-native", DeviceID: "device-native"}, nil
	default:
		return nil, auth.ErrSessionInvalid
	}
}
func (wsCookieSessionStore) TouchSession(context.Context, string) error        { return nil }
func (wsCookieSessionStore) RevokeSession(context.Context, string) error       { return nil }
func (wsCookieSessionStore) RevokeAllForAccount(context.Context, string) error { return nil }
func (wsCookieSessionStore) RevokeAllForDevice(context.Context, string) error  { return nil }
func (wsCookieSessionStore) RotateSession(context.Context, string, string, string) (string, error) {
	return "", nil
}

func TestWebSocketCookieHandshakeAuthenticatesSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h := hub.New(nil)
	go h.Run(ctx)

	cfg := &config.Config{SessionCookieName: "nodus_session"}
	server := httptest.NewServer(WebSocket(h, nil, nil, nil, wsCookieSessionStore{}, cfg, nil, nil))
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

// A native (Expo) client has no browser cookie jar, so the WS handshake must
// accept the same opaque session ID as `Authorization: Bearer`. It must also
// omit Origin (native stacks do not send one) — otherwise the Phase 14a browser
// rejection would close the socket before the bearer ever resolved.
func TestWebSocketBearerHandshakeAuthenticatesNativeClient(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h := hub.New(nil)
	go h.Run(ctx)

	cfg := &config.Config{SessionCookieName: "nodus_session"}
	server := httptest.NewServer(WebSocket(h, nil, nil, nil, wsCookieSessionStore{}, cfg, nil, nil))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	header := http.Header{"Authorization": {"Bearer native-session"}}
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	require.NoError(t, err)
	defer conn.Close()

	// Drain the node challenge the server sends on every accepted handshake.
	_, _, err = conn.ReadMessage()
	require.NoError(t, err)

	h.SendToAccount("acct-native", []byte(`{"type":"bearer_session_verified"}`))
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	_, payload, err := conn.ReadMessage()
	require.NoError(t, err)
	require.Contains(t, string(payload), "bearer_session_verified")
}

func TestWebSocketRejectsUnauthenticatedBrowser(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h := hub.New(nil)
	go h.Run(ctx)

	cfg := &config.Config{
		SessionCookieName: "nodus_session",
		AllowedOrigins:    []string{"http://localhost"},
	}
	server := httptest.NewServer(WebSocket(h, nil, nil, nil, wsCookieSessionStore{}, cfg, nil, nil))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	// Simulate a browser: an Origin header (native nodes omit it) but no
	// session cookie. The Relay must reject the handshake with the Phase 14a
	// close code so the web client can distinguish auth failure from a
	// transient network error.
	header := http.Header{"Origin": {"http://localhost"}}
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	require.NoError(t, err)
	defer conn.Close()

	_, _, err = conn.ReadMessage()
	require.Error(t, err)
	var closeErr *websocket.CloseError
	require.ErrorAs(t, err, &closeErr)
	require.Equal(t, hub.CloseCodeUnauthorized, closeErr.Code)
}
