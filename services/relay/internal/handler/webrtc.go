package handler

import (
	"context"
	"encoding/json"
	"log"

	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
)

// WebRTCSignalingPayload represents the wire shape for webrtc_offer, webrtc_answer, webrtc_ice_candidate.
type WebRTCSignalingPayload struct {
	FromPeer  string `json:"from_peer"`
	ToPeer    string `json:"to_peer"`
	SDP       string `json:"sdp,omitempty"`
	Candidate string `json:"candidate,omitempty"`
}

// HandleWebRTCSignaling proxies WebRTC signaling messages directly to the destination peer (Path B).
// The Relay carries SDP and ICE candidates without inspecting or storing payload contents.
func HandleWebRTCSignaling(
	ctx context.Context,
	c *hub.Client,
	env ProtocolEnvelope,
	h *hub.Hub,
) {
	var payload WebRTCSignalingPayload
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		log.Printf("[relay-webrtc] invalid signaling payload from conn=%s: %v", c.ConnID, err)
		return
	}

	if payload.ToPeer == "" {
		log.Printf("[relay-webrtc] missing to_peer in signaling message from conn=%s", c.ConnID)
		return
	}

	if (c.NodeID != "" && payload.FromPeer != c.NodeID) && (c.DeviceID != "" && payload.FromPeer != c.DeviceID) {
		log.Printf("[relay-webrtc] from_peer spoofing attempt from conn=%s: claimed=%s actual_node=%s actual_device=%s", c.ConnID, payload.FromPeer, c.NodeID, c.DeviceID)
		return
	}

	// Re-serialize the full envelope to forward to the target peer
	rawMsg, err := json.Marshal(env)
	if err != nil {
		log.Printf("[relay-webrtc] failed to marshal envelope: %v", err)
		return
	}

	sent := h.SendToPeer(payload.ToPeer, rawMsg)
	if !sent {
		log.Printf("[relay-webrtc] destination peer %s is not connected (type=%s)", payload.ToPeer, env.Type)
		// Optionally send an error response back to sender indicating peer is unavailable
	}
}
