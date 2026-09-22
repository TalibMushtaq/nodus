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

// encodeFrame mirrors the node's tagged shard stream frame:
// `[u8 version][u16be id_len][request_id][payload]`.
func encodeFrame(requestID string, payload []byte) []byte {
	frame := make([]byte, shardFrameHeaderBytes+len(requestID)+len(payload))
	frame[0] = shardFrameVersion
	frame[1] = byte(len(requestID) >> 8)
	frame[2] = byte(len(requestID))
	copy(frame[shardFrameHeaderBytes:], requestID)
	copy(frame[shardFrameHeaderBytes+len(requestID):], payload)
	return frame
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
	// Multiple tagged binary frames then the done marker: one streamed shard.
	reg.ResolveBinary(shardClient("conn-a", "node-a"), encodeFrame("req-1", []byte("shard-")))
	reg.ResolveBinary(shardClient("conn-a", "node-a"), encodeFrame("req-1", []byte("bytes")))
	reg.HandleDone(shardClient("conn-a", "node-a"), ProtocolEnvelope{
		Payload: []byte(`{"request_id":"req-1"}`),
	})

	require.Equal(t, "shard-", string(recvChunk(t, ch).data))
	require.Equal(t, "bytes", string(recvChunk(t, ch).data))
	require.True(t, recvChunk(t, ch).done)
}

// Concurrent fetches on one node connection must be routed by request_id, not
// clobbered: this is the regression the per-connection arming scheme caused.
func TestShardFetchConcurrentStreamsRouteByRequestID(t *testing.T) {
	reg := NewShardFetchRegistry()
	chA, cleanupA := reg.register("req-a", "node-a")
	defer cleanupA()
	chB, cleanupB := reg.register("req-b", "node-a")
	defer cleanupB()

	node := shardClient("conn-a", "node-a")
	reg.HandleResult(node, ProtocolEnvelope{Payload: []byte(`{"request_id":"req-a","object_id":"a","status":"ok"}`)})
	reg.HandleResult(node, ProtocolEnvelope{Payload: []byte(`{"request_id":"req-b","object_id":"b","status":"ok"}`)})

	// Interleave the two streams the way a node serving both would.
	reg.ResolveBinary(node, encodeFrame("req-b", []byte("b1")))
	reg.ResolveBinary(node, encodeFrame("req-a", []byte("a1")))
	reg.ResolveBinary(node, encodeFrame("req-b", []byte("b2")))
	reg.HandleDone(node, ProtocolEnvelope{Payload: []byte(`{"request_id":"req-a"}`)})
	reg.HandleDone(node, ProtocolEnvelope{Payload: []byte(`{"request_id":"req-b"}`)})

	require.Equal(t, "a1", string(recvChunk(t, chA).data))
	require.True(t, recvChunk(t, chA).done)

	require.Equal(t, "b1", string(recvChunk(t, chB).data))
	require.Equal(t, "b2", string(recvChunk(t, chB).data))
	require.True(t, recvChunk(t, chB).done)
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

func TestShardFetchIgnoresOtherNodeAndUnroutedBinary(t *testing.T) {
	reg := NewShardFetchRegistry()
	ch, cleanup := reg.register("req-3", "node-a")
	defer cleanup()

	// A DIFFERENT node may not answer a request assigned to node-a.
	reg.HandleResult(shardClient("conn-b", "node-b"), ProtocolEnvelope{
		Payload: []byte(`{"request_id":"req-3","object_id":"obj","status":"missing"}`),
	})
	reg.ResolveBinary(shardClient("conn-b", "node-b"), encodeFrame("req-3", []byte("stray")))

	select {
	case chunk := <-ch:
		t.Fatalf("a different node resolved the shard fetch: %+v", chunk)
	case <-time.After(50 * time.Millisecond):
	}

	// A frame tagging an unknown request must be dropped, not panic.
	require.NotPanics(t, func() {
		reg.ResolveBinary(shardClient("conn-c", "node-a"), encodeFrame("req-unknown", []byte("orphan")))
	})
	// A malformed frame (bad version / truncated header) is dropped too.
	require.NotPanics(t, func() {
		reg.ResolveBinary(shardClient("conn-a", "node-a"), []byte{0x02, 0x00})
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
		reg.ResolveBinary(shardClient("conn-a", "node-a"), encodeFrame("req-4", []byte("late")))
	})
}

func TestDecodeShardFrameRejectsMalformed(t *testing.T) {
	_, _, ok := decodeShardFrame([]byte{})
	require.False(t, ok)
	// Version mismatch.
	_, _, ok = decodeShardFrame([]byte{0x09, 0x00, 0x01, 'x'})
	require.False(t, ok)
	// Length overruns the buffer.
	_, _, ok = decodeShardFrame([]byte{shardFrameVersion, 0x00, 0x05, 'a'})
	require.False(t, ok)

	id, payload, ok := decodeShardFrame(encodeFrame("req-x", []byte("hello")))
	require.True(t, ok)
	require.Equal(t, "req-x", id)
	require.Equal(t, "hello", string(payload))
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
