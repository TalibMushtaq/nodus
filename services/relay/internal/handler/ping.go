package handler

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/google/uuid"
)

// pingTimeout bounds how long the HTTP handler waits for a pong before it
// reports the peer unreachable. A manual probe should feel immediate, so this
// is deliberately short; the target runtimes reply inline.
const pingTimeout = 3 * time.Second

// PingTracker correlates an outstanding ping with the pong that answers it.
// The HTTP request that starts a ping and the WS read loop that observes the
// pong run on different goroutines and share no other channel, so a small
// in-process map is the bridge. Keyed by an unguessable UUID so a peer cannot
// resolve (or spoof) another ping.
type PingTracker struct {
	mu      sync.Mutex
	waiters map[string]chan struct{}
}

func NewPingTracker() *PingTracker {
	return &PingTracker{waiters: make(map[string]chan struct{})}
}

// register returns a channel closed when the matching pong arrives, plus a
// cleanup that must be deferred. Cleanup is idempotent with signal.
func (t *PingTracker) register(id string) (<-chan struct{}, func()) {
	ch := make(chan struct{})
	t.mu.Lock()
	t.waiters[id] = ch
	t.mu.Unlock()
	return ch, func() {
		t.mu.Lock()
		delete(t.waiters, id)
		t.mu.Unlock()
	}
}

// signal resolves the waiter for id, if any. Deleting before closing makes a
// duplicate pong a no-op instead of a double-close panic.
func (t *PingTracker) signal(id string) {
	t.mu.Lock()
	ch, ok := t.waiters[id]
	if ok {
		delete(t.waiters, id)
	}
	t.mu.Unlock()
	if ok {
		close(ch)
	}
}

// PingResponse is the result of a manual reachability probe.
type PingResponse struct {
	Online bool  `json:"online"`
	RTTMs  int64 `json:"rtt_ms,omitempty"`
	// Reason explains an offline result: "offline" (no live connection) or
	// "timeout" (connected but did not answer in time).
	Reason string `json:"reason,omitempty"`
}

// HandlePong resolves an outstanding manual ping. Both storage nodes and
// browser/mobile devices echo the ping, so this must accept either.
func HandlePong(tracker *PingTracker, env ProtocolEnvelope) {
	if tracker == nil {
		return
	}
	var payload struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil || payload.ID == "" {
		return
	}
	tracker.signal(payload.ID)
}

// PingPeer probes one node or device and reports whether it answered. `kind` is
// "node" or "device" and selects the ownership table and hub route.
//
// Unlike the hub's SendTo* bool (which only proves the Relay holds a socket),
// this waits for the target's pong, so a hung peer with an open socket is
// reported unreachable.
func PingPeer(pool *db.Pool, h *hub.Hub, tracker *PingTracker, kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		accountID, ok := auth.GetAccountID(r.Context())
		if !ok {
			respondError(w, http.StatusUnauthorized, "unauthorized")
			return
		}

		peerID := ""
		if kind == "node" {
			peerID = r.PathValue("node_id")
		} else {
			peerID = r.PathValue("device_id")
		}
		if peerID == "" {
			respondError(w, http.StatusBadRequest, "peer id is required")
			return
		}

		// Only probe a peer this account actually owns and that is ACTIVE.
		var owned bool
		if kind == "node" {
			if err := pool.QueryRow(r.Context(),
				`SELECT EXISTS(SELECT 1 FROM storage_nodes WHERE node_id=$1 AND account_id=$2 AND status='ACTIVE')`,
				peerID, accountID).Scan(&owned); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to look up node")
				return
			}
		} else {
			if err := pool.QueryRow(r.Context(),
				`SELECT EXISTS(SELECT 1 FROM devices WHERE device_id=$1 AND account_id=$2 AND status='ACTIVE')`,
				peerID, accountID).Scan(&owned); err != nil {
				respondError(w, http.StatusInternalServerError, "failed to look up device")
				return
			}
		}
		if !owned {
			respondError(w, http.StatusNotFound, "peer not found")
			return
		}

		correlationID := uuid.NewString()
		ch, cancel := tracker.register(correlationID)
		defer cancel()

		payload, err := json.Marshal(map[string]string{"id": correlationID})
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to encode ping")
			return
		}
		raw, err := json.Marshal(ProtocolEnvelope{
			Type:          "ping",
			SchemaVersion: "1.0.0",
			MessageID:     uuid.NewString(),
			Timestamp:     time.Now().UTC().Format(time.RFC3339),
			Payload:       payload,
		})
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to encode ping")
			return
		}

		started := time.Now()
		delivered := false
		if kind == "node" {
			delivered = h.SendToNode(peerID, raw)
		} else {
			delivered = h.SendToDevice(peerID, raw)
		}
		if !delivered {
			respondJSON(w, http.StatusOK, PingResponse{Online: false, Reason: "offline"})
			return
		}

		select {
		case <-ch:
			respondJSON(w, http.StatusOK, PingResponse{Online: true, RTTMs: time.Since(started).Milliseconds()})
		case <-time.After(pingTimeout):
			respondJSON(w, http.StatusOK, PingResponse{Online: false, Reason: "timeout"})
		case <-r.Context().Done():
			// The client gave up; the deferred cleanup removes the waiter.
			return
		}
	}
}
