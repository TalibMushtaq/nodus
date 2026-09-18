package hub_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/require"
)

// WritePump must emit exactly one protocol envelope per WebSocket text frame.
// It previously coalesced queued messages into a single newline-joined frame
// (the Gorilla example optimization), which every client parses as one JSON
// value and rejects with "trailing characters", silently dropping events.
func TestWritePumpSendsOneEnvelopePerFrame(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	serverConn := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serverConn <- conn
	}))
	defer srv.Close()

	dialURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	clientConn, _, err := websocket.DefaultDialer.Dial(dialURL, nil)
	require.NoError(t, err)
	defer clientConn.Close()

	conn := <-serverConn
	client := &hub.Client{Conn: conn, Send: make(chan []byte, 4)}
	go client.WritePump()

	// Queue both before WritePump has a chance to drain, so the old coalescing
	// path would join them into one frame.
	client.Send <- []byte(`{"type":"a"}`)
	client.Send <- []byte(`{"type":"b"}`)

	for _, want := range []string{`{"type":"a"}`, `{"type":"b"}`} {
		require.NoError(t, clientConn.SetReadDeadline(time.Now().Add(2*time.Second)))
		_, data, err := clientConn.ReadMessage()
		require.NoError(t, err)
		require.Equal(t, want, string(data))
	}
}
