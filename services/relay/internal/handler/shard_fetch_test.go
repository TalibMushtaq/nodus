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

func recvChunk(t *testing.T, ch <-chan shardFetchChunk) shardFetchChunk {
	t.Helper()
	select {
	case chunk := <-ch:
		return chunk
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for a shard chunk")
		return shardFetchChunk{}
	}
}

func TestShardFetchOkResultStreamsChunksThenDone(t *testing.T) {
	reg := NewShardFetchRegistry()
	ch, cleanup := reg.register("req-1", "node-a")
	defer cleanup()

	reg.HandleResult(shardClient("conn-a", "node-a"), ProtocolEnvelope{
		Payload: []byte(`{"request_id":"req-1","object_id":"obj","status":"ok"}`),
	})
	// Multiple binary frames then the done marker: one streamed shard.
	reg.ResolveBinary(shardClient("conn-a", "node-a"), []byte("shard-"))
	reg.ResolveBinary(shardClient("conn-a", "node-a"), []byte("bytes"))
	reg.HandleDone(shardClient("conn-a", "node-a"), ProtocolEnvelope{
		Payload: []byte(`{"request_id":"req-1"}`),
	})

	require.Equal(t, "shard-", string(recvChunk(t, ch).data))
	require.Equal(t, "bytes", string(recvChunk(t, ch).data))
	require.True(t, recvChunk(t, ch).done)
}

func TestShardFetchErrorResolvesWithoutBinary(t *testing.T) {
	reg := NewShardFetchRegistry()
	ch, cleanup := reg.register("req-2", "node-a")
	defer cleanup()

	reg.HandleResult(shardClient("conn-a", "node-a"), ProtocolEnvelope{
		Payload: []byte(`{"request_id":"req-2","object_id":"obj","status":"missing","error":"not found"}`),
	})

	chunk := recvChunk(t, ch)
	require.Empty(t, chunk.data)
	require.Contains(t, chunk.err, "not found")
	require.True(t, chunk.done)
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
	case chunk := <-ch:
		t.Fatalf("a different node resolved the shard fetch: %+v", chunk)
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
