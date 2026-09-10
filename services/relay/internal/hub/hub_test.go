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
