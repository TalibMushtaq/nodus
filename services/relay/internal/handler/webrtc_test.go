package handler_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/handler"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
)

func TestHandleWebRTCSignaling_ProxiesOfferToTargetPeer(t *testing.T) {
	h := hub.New(nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go h.Run(ctx)

	// Sender device client
	sender := &hub.Client{
		Hub:      h,
		ConnID:   "conn-device-1",
		DeviceID: "device-1",
		Send:     make(chan []byte, 10),
	}
	h.Register(sender)

	// Receiver node client
	receiver := &hub.Client{
		Hub:    h,
		ConnID: "conn-node-1",
		NodeID: "node-1",
		Send:   make(chan []byte, 10),
	}
	h.Register(receiver)

	time.Sleep(50 * time.Millisecond)

	// WebRTC Offer envelope
	payloadBytes, _ := json.Marshal(map[string]string{
		"from_peer": "device-1",
		"to_peer":   "node-1",
		"sdp":       "v=0\r\no=test-sdp",
	})
	env := handler.ProtocolEnvelope{
		Type:          "webrtc_offer",
		SchemaVersion: "1.0",
		MessageID:     "msg-001",
		Payload:       payloadBytes,
	}

	handler.HandleWebRTCSignaling(context.Background(), sender, env, h)

	select {
	case msg := <-receiver.Send:
		var receivedEnv handler.ProtocolEnvelope
		if err := json.Unmarshal(msg, &receivedEnv); err != nil {
			t.Fatalf("failed to unmarshal received envelope: %v", err)
		}
		if receivedEnv.Type != "webrtc_offer" {
			t.Errorf("expected type webrtc_offer, got %s", receivedEnv.Type)
		}
		var payload handler.WebRTCSignalingPayload
		if err := json.Unmarshal(receivedEnv.Payload, &payload); err != nil {
			t.Fatalf("failed to unmarshal payload: %v", err)
		}
		if payload.FromPeer != "device-1" || payload.ToPeer != "node-1" || payload.SDP != "v=0\r\no=test-sdp" {
			t.Errorf("unexpected payload: %+v", payload)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for relayed WebRTC signaling message")
	}
}
