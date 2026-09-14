package handler

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
	"github.com/stretchr/testify/require"
)

func shardClient(connID, nodeID string) *hub.Client {
	return &hub.Client{ConnID: connID, NodeID: nodeID}
}

func TestShardFetchOkResultArmsBinaryAndResolves(t *testing.T) {
	reg := NewShardFetchRegistry()
	ch, cleanup := reg.register("req-1", "node-a")
	defer cleanup()

	reg.HandleResult(shardClient("conn-a", "node-a"), ProtocolEnvelope{
		Payload: []byte(`{"request_id":"req-1","object_id":"obj","status":"ok"}`),
	})
	// The binary frame that follows on the same connection resolves the waiter.
	reg.ResolveBinary(shardClient("conn-a", "node-a"), []byte("shard-bytes"))

	select {
	case answer := <-ch:
		require.Equal(t, "shard-bytes", string(answer.bytes))
	case <-time.After(time.Second):
		t.Fatal("ok result + binary frame did not resolve the shard fetch")
	}
}

func TestShardFetchErrorResolvesWithoutBinary(t *testing.T) {
	reg := NewShardFetchRegistry()
	ch, cleanup := reg.register("req-2", "node-a")
	defer cleanup()

	reg.HandleResult(shardClient("conn-a", "node-a"), ProtocolEnvelope{
		Payload: []byte(`{"request_id":"req-2","object_id":"obj","status":"missing","error":"not found"}`),
	})

	select {
	case answer := <-ch:
		require.Empty(t, answer.bytes)
		require.Contains(t, answer.err, "not found")
	case <-time.After(time.Second):
		t.Fatal("error result did not resolve the waiter")
	}
}

func TestShardFetchIgnoresOtherNodeAndUnarmedBinary(t *testing.T) {
	reg := NewShardFetchRegistry()
	ch, cleanup := reg.register("req-3", "node-a")
	defer cleanup()

	// A DIFFERENT node may not answer a request assigned to node-a.
	reg.HandleResult(shardClient("conn-b", "node-b"), ProtocolEnvelope{
		Payload: []byte(`{"request_id":"req-3","object_id":"obj","status":"missing"}`),
	})
	reg.ResolveBinary(shardClient("conn-b", "node-b"), []byte("stray"))

	select {
	case <-ch:
		t.Fatal("a different node resolved the shard fetch")
	case <-time.After(50 * time.Millisecond):
	}

	// A binary frame without an armed result must be dropped, not panic.
	require.NotPanics(t, func() {
		reg.ResolveBinary(shardClient("conn-c", "node-a"), []byte("orphan"))
	})
}

func TestShardFetchCleanupRemovesWaiter(t *testing.T) {
	reg := NewShardFetchRegistry()
	_, cleanup := reg.register("req-4", "node-a")
	cleanup()

	require.NotPanics(t, func() {
		reg.HandleResult(shardClient("conn-a", "node-a"), ProtocolEnvelope{
			Payload: []byte(`{"request_id":"req-4","object_id":"obj","status":"ok"}`),
		})
		reg.ResolveBinary(shardClient("conn-a", "node-a"), []byte("late"))
	})
}

func TestValidShardObjectID(t *testing.T) {
	require.True(t, validShardObjectID("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"))
	require.False(t, validShardObjectID("short"))
	require.False(t, validShardObjectID("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"))
	require.False(t, validShardObjectID("gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg"))
}

func TestShardFetchResultUsesSnakeCaseWireNames(t *testing.T) {
	raw, err := json.Marshal(shardFetchResultPayload{RequestID: "r", ObjectID: "o", Status: "ok"})
	require.NoError(t, err)
	require.Contains(t, string(raw), `"request_id":"r"`)
	require.Contains(t, string(raw), `"object_id":"o"`)
}