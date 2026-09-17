package hub

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The offline hook fires only once a peer's last connection has gone, and only
// for the peer kind that actually disconnected.
func TestPeerOfflineHookFiresForNode(t *testing.T) {
	h := New(nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go h.Run(ctx)

	fired := make(chan string, 2)
	h.SetPeerOfflineHook(func(accountID, peerID, kind string) {
		fired <- accountID + ":" + kind + ":" + peerID
	})

	client := &Client{Hub: h, ConnID: "c1", AccountID: "acct1", NodeID: "node1", Send: make(chan []byte, 1)}
	// Register/Unregister are unbuffered channel sends, so Run has processed
	// the register before Unregister is even accepted.
	h.Register(client)
	h.Unregister(client)

	select {
	case got := <-fired:
		require.Equal(t, "acct1:node:node1", got)
	case <-time.After(time.Second):
		t.Fatal("expected the peer-offline hook to fire for the node")
	}
}

// A device-only client leaves no node route, so the hook reports a device.
func TestPeerOfflineHookReportsDevice(t *testing.T) {
	h := New(nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go h.Run(ctx)

	fired := make(chan string, 2)
	h.SetPeerOfflineHook(func(accountID, peerID, kind string) {
		fired <- kind
	})

	client := &Client{Hub: h, ConnID: "c2", AccountID: "acct2", DeviceID: "dev2", Send: make(chan []byte, 1)}
	h.Register(client)
	h.Unregister(client)

	select {
	case got := <-fired:
		require.Equal(t, "device", got)
	case <-time.After(time.Second):
		t.Fatal("expected the peer-offline hook to fire for the device")
	}
}
