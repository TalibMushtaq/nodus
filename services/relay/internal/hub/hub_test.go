package hub_test

import (
	"context"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
)

func TestHubClientLifecycle(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h := hub.New(nil)
	go h.Run(ctx)

	client := &hub.Client{
		Hub:       h,
		ConnID:    "conn-1",
		AccountID: "acc-1",
		NodeID:    "node-1",
		Send:      make(chan []byte, 10),
	}

	h.Register(client)

	// Wait for registration loop
	time.Sleep(20 * time.Millisecond)

	msg := []byte("hello node")
	sent := h.SendToNode("node-1", msg)
	if !sent {
		t.Fatalf("expected message to be sent to node-1")
	}

	select {
	case received := <-client.Send:
		if string(received) != string(msg) {
			t.Fatalf("expected message %s, got %s", msg, received)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatalf("timed out waiting for message")
	}

	// Unregister
	h.Unregister(client)
	time.Sleep(20 * time.Millisecond)

	sent = h.SendToNode("node-1", msg)
	if sent {
		t.Fatalf("expected message not to be sent after unregister")
	}
}

// SendToDevices must reach browser/device connections but never storage nodes,
// which share the same account registry but speak a node-only message set.
func TestSendToDevicesSkipsNodes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	h := hub.New(nil)
	go h.Run(ctx)

	device := &hub.Client{
		Hub: h, ConnID: "dev-conn", AccountID: "acc-1", DeviceID: "dev-1",
		Send: make(chan []byte, 4),
	}
	node := &hub.Client{
		Hub: h, ConnID: "node-conn", AccountID: "acc-1", NodeID: "node-1",
		Send: make(chan []byte, 4),
	}
	h.Register(device)
	h.Register(node)
	time.Sleep(20 * time.Millisecond)

	h.SendToDevices("acc-1", []byte("catalog_changed"))

	select {
	case <-device.Send:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("device did not receive the device-only broadcast")
	}
	select {
	case msg := <-node.Send:
		t.Fatalf("node received a device-only broadcast: %s", msg)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestClientRateLimitAllowed(t *testing.T) {
	c := &hub.Client{}
	now := time.Now()
	for i := 0; i < 250; i++ {
		if !c.RateLimitAllowed(now) {
			t.Fatalf("request %d in burst was rejected", i)
		}
	}
	if c.RateLimitAllowed(now) {
		t.Fatal("request beyond burst was accepted")
	}
	if !c.RateLimitAllowed(now.Add(10 * time.Millisecond)) {
		t.Fatal("refilled token was not accepted")
	}
}

func TestUnregisterOldConnectionKeepsNewPeerRoute(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := hub.New(nil)
	go h.Run(ctx)

	oldClient := &hub.Client{Hub: h, ConnID: "old", NodeID: "node-1", Send: make(chan []byte, 1)}
	newClient := &hub.Client{Hub: h, ConnID: "new", NodeID: "node-1", Send: make(chan []byte, 1)}
	h.Register(oldClient)
	h.Register(newClient)
	h.Unregister(oldClient)

	if !h.SendToNode("node-1", []byte("still connected")) {
		t.Fatal("old disconnect removed the newer node route")
	}
	select {
	case <-newClient.Send:
	case <-time.After(time.Second):
		t.Fatal("message was not routed to newer connection")
	}
}
