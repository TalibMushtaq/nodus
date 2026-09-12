package handler

import (
	"testing"

	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
)

func TestMessageRequiresNode(t *testing.T) {
	// Phase 14: event_batch is reachable by an authenticated device, so it is
	// no longer in the node-only set; the rest still are.
	for _, messageType := range []string{"sync_hello", "snapshot_begin", "snapshot_chunk", "snapshot_end", "shard_ack"} {
		if !messageRequiresNode(messageType) {
			t.Errorf("%q should require a node identity", messageType)
		}
	}
	for _, messageType := range []string{"event_batch", "heartbeat", "register", "webrtc_offer", "node_auth_response"} {
		if messageRequiresNode(messageType) {
			t.Errorf("%q should not require a node identity", messageType)
		}
	}
}

func TestPresencePeerIDUsesAuthenticatedConnectionIdentity(t *testing.T) {
	if got := presencePeerID(&hub.Client{NodeID: "node-authenticated", DeviceID: "device-also-set"}); got != "node-authenticated" {
		t.Fatalf("presencePeerID() = %q, want node-authenticated", got)
	}
	if got := presencePeerID(&hub.Client{DeviceID: "device-authenticated"}); got != "device-authenticated" {
		t.Fatalf("presencePeerID() = %q, want device-authenticated", got)
	}
	if got := presencePeerID(&hub.Client{}); got != "" {
		t.Fatalf("presencePeerID() = %q, want empty", got)
	}
}
