package handler

import (
	"context"
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

// peerOwned reports whether `peerID` is an ACTIVE node or device this account
// owns. Shared by the HTTP probe and the WS presence query so both enforce the
// same ownership rule.
func peerOwned(ctx context.Context, pool *db.Pool, accountID, peerID, kind string) (bool, error) {
	var owned bool
	if kind == "node" {
		return owned, pool.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM storage_nodes WHERE node_id=$1 AND account_id=$2 AND status='ACTIVE')`,
			peerID, accountID).Scan(&owned)
	}
	return owned, pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM devices WHERE device_id=$1 AND account_id=$2 AND status='ACTIVE')`,
		peerID, accountID).Scan(&owned)
}

// PresenceQueryPayload is the device → Relay WS reachability request.
type PresenceQueryPayload struct {
	RequestID string `json:"request_id"`
	PeerID    string `json:"peer_id"`
	Kind      string `json:"kind"`
}

// PresenceResultPayload is the Relay → device WS reachability answer.
type PresenceResultPayload struct {
	RequestID string `json:"request_id"`
	PeerID    string `json:"peer_id"`
	Kind      string `json:"kind"`
	Online    bool   `json:"online"`
	RTTMs     int64  `json:"rtt_ms,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// HandlePresenceQuery answers a device's WS reachability probe by forwarding a
// `ping` to the target over its socket and replying with presence_result. It is
// the WebSocket counterpart of PingPeer, reusing the same ownership check and
// PingTracker so both paths report the same verdict. Device-only: the caller
// must be a session-authenticated browser/device, never a storage node.
func HandlePresenceQuery(
	ctx context.Context,
	c *hub.Client,
	env ProtocolEnvelope,
	pool *db.Pool,
	h *hub.Hub,
	tracker *PingTracker,
) {
	if pool == nil || h == nil || tracker == nil || c == nil {
		return
	}
	if c.NodeID != "" || c.DeviceID == "" || c.AccountID == "" {
		return
	}

	var q PresenceQueryPayload
	if err := json.Unmarshal(env.Payload, &q); err != nil || q.RequestID == "" || q.PeerID == "" {
		return
	}
	if q.Kind != "node" && q.Kind != "device" {
		return
	}

	// Reply on the requester's own socket. Never awaited by the read loop.
	reply := func(rttMs int64, online bool, reason string) {
		_ = sendEnvelope(c, "presence_result", PresenceResultPayload{
			RequestID: q.RequestID,
			PeerID:    q.PeerID,
			Kind:      q.Kind,
			Online:    online,
			RTTMs:     rttMs,
			Reason:    reason,
		})
	}

	owned, err := peerOwned(ctx, pool, c.AccountID, q.PeerID, q.Kind)
	if err != nil {
		reply(0, false, "lookup_failed")
		return
	}
	if !owned {
		reply(0, false, "not_found")
		return
	}

	correlationID := uuid.NewString()
	ch, cancel := tracker.register(correlationID)
	defer cancel()

	payload, err := json.Marshal(map[string]string{"id": correlationID})
	if err != nil {
		reply(0, false, "encode_failed")
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
		reply(0, false, "encode_failed")
		return
	}

	started := time.Now()
	delivered := false
	if q.Kind == "node" {
		delivered = h.SendToNode(q.PeerID, raw)
	} else {
		delivered = h.SendToDevice(q.PeerID, raw)
	}
	if !delivered {
		reply(0, false, "offline")
		return
	}

	select {
	case <-ch:
		reply(time.Since(started).Milliseconds(), true, "")
	case <-time.After(pingTimeout):
		reply(0, false, "timeout")
	case <-ctx.Done():
		// Caller/relay shutting down; the deferred cleanup drops the waiter.
		return
	}
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
		owned, err := peerOwned(r.Context(), pool, accountID, peerID, kind)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to look up peer")
			return
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
