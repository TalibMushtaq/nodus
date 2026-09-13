package handler

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestPingTrackerPongResolvesWaiter(t *testing.T) {
	tracker := NewPingTracker()
	ch, cancel := tracker.register("corr-1")
	defer cancel()

	HandlePong(tracker, ProtocolEnvelope{Payload: []byte(`{"id":"corr-1"}`)})

	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatal("pong did not resolve the outstanding ping")
	}

	// A duplicate pong must be a no-op (signal deletes before closing).
	require.NotPanics(t, func() {
		HandlePong(tracker, ProtocolEnvelope{Payload: []byte(`{"id":"corr-1"}`)})
	})
}

func TestPingTrackerIgnoresUnknownAndMalformed(t *testing.T) {
	tracker := NewPingTracker()
	ch, cancel := tracker.register("corr-2")
	defer cancel()

	HandlePong(tracker, ProtocolEnvelope{Payload: []byte(`{"id":"someone-else"}`)})
	HandlePong(tracker, ProtocolEnvelope{Payload: []byte(`not json`)})
	HandlePong(tracker, ProtocolEnvelope{Payload: []byte(`{"id":""}`)})

	select {
	case <-ch:
		t.Fatal("an unrelated or malformed pong resolved the ping")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestPingTrackerCleanupRemovesWaiter(t *testing.T) {
	tracker := NewPingTracker()
	_, cancel := tracker.register("corr-3")
	cancel()

	require.NotPanics(t, func() {
		HandlePong(tracker, ProtocolEnvelope{Payload: []byte(`{"id":"corr-3"}`)})
	})
	require.NotPanics(t, cancel)
}
