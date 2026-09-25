package handler

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
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

// recvChunk mirrors what the HTTP handler sees: an ordered chunk, or the abort
// reason surfaced as an error chunk, or nothing before the deadline.
func recvChunk(t *testing.T, wait *shardFetchWait) shardFetchChunk {
	t.Helper()
	select {
	case err := <-wait.abort:
		return shardFetchChunk{err: err.Error(), done: true}
	default:
	}
	select {
	case chunk := <-wait.ch:
		return chunk
	case err := <-wait.abort:
		return shardFetchChunk{err: err.Error(), done: true}
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
	wait, cleanup := reg.register("req-3", "node-a")
	defer cleanup()

	// A DIFFERENT node may not answer a request assigned to node-a.
	reg.HandleResult(shardClient("conn-b", "node-b"), ProtocolEnvelope{
		Payload: []byte(`{"request_id":"req-3","object_id":"obj","status":"missing"}`),
	})
	reg.ResolveBinary(shardClient("conn-b", "node-b"), encodeFrame("req-3", []byte("stray")))

	select {
	case chunk := <-wait.ch:
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

// TestShardFetchSendsNeverBlockTheReadLoop covers the flow control between the
// node's WebSocket read loop and the HTTP handler draining the response.
//
// Every registry callback is invoked *from* the read loop, so a send that blocks
// is a blocked read loop, and one blocked read loop stalls every later message on
// that node's connection — pings, batch acks, other concurrent fetches. The
// channel is buffered to absorb a burst, but a buffer is a delay, not a bound: a
// slow browser on a multi-MiB shard fills it, and the handler's cleanup used to
// leave the send parked forever with no reader, wedging the connection for the
// life of the process.
func TestShardFetchSendsNeverBlockTheReadLoop(t *testing.T) {
	reg := NewShardFetchRegistry()
	client := &hub.Client{NodeID: "node-blocked"}

	wait, cleanup := reg.register("req-blocked", "node-blocked")

	// Fill the channel to capacity, standing in for a consumer that is not
	// keeping up. The read loop copies each chunk before sending, so these are
	// chunks it has already pulled off the socket.
	for i := 0; i < cap(wait.ch); i++ {
		wait.ch <- shardFetchChunk{data: []byte("chunk")}
	}
	require.Len(t, wait.ch, cap(wait.ch), "the channel should be full before the next send")

	// This send has nowhere to go. It must return anyway: the fetch is failed
	// rather than parked, because the caller is the read loop.
	sent := make(chan struct{})
	go func() {
		defer close(sent)
		reg.ResolveBinary(client, encodeFrame("req-blocked", []byte("one-chunk-too-many")))
	}()
	select {
	case <-sent:
	case <-time.After(2 * time.Second):
		t.Fatal("the send blocked with a full channel: this node's read loop is stalled")
	}

	// The consumer is told why, rather than being left waiting on a stream that
	// has already lost a chunk, and it stops there instead of writing the chunks
	// still queued behind the failure.
	chunk := recvChunk(t, wait)
	require.NotEmpty(t, chunk.err, "an overflowed fetch must report why it stopped")
	require.True(t, chunk.done)

	// Abandoning the fetch — client disconnect, or the idle timeout — must leave
	// later sends harmless rather than wedged.
	cleanup()
	for i := range 3 {
		done := make(chan struct{})
		go func() {
			defer close(done)
			reg.ResolveBinary(client, encodeFrame("req-blocked", []byte("late")))
			reg.HandleResult(client, ProtocolEnvelope{
				Payload: []byte(`{"request_id":"req-late-` + string(rune('0'+i)) + `","status":"ok"}`),
			})
		}()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("a send blocked after the fetch was abandoned")
		}
	}
}

// testMaxShardBytes is the cap the FetchShard tests exercise; the real value
// comes from config.
const testMaxShardBytes = 32 * 1024

// TestShardStreamCeiling covers who gets to set the bound on a relayed shard.
// The recorded size is the tightest available and is what makes a short read
// visible to the client, but it is a claim by the same holder that is about to
// send the bytes, so it can only ever lower the limit.
func TestShardStreamCeiling(t *testing.T) {
	const maxShard = 32 * 1024
	hard := int64(maxShard) + shardStreamOverheadBytes

	// A recorded size below the configured maximum is used as-is.
	require.Equal(t, int64(4096), shardStreamCeiling(4096, maxShard))
	require.Equal(t, int64(4096), shardStreamCeiling(4096, maxShard-1),
		"a smaller configured maximum must win over the recorded size")

	// A node that declares a shard larger than the relay accepts must not thereby
	// raise its own limit.
	require.Equal(t, hard, shardStreamCeiling(1<<50, maxShard))
	require.Equal(t, hard, shardStreamCeiling(hard+1, maxShard))

	// Rows written before size_bytes existed, and nonsense values, fall back to
	// the configured ceiling rather than to zero.
	require.Equal(t, hard, shardStreamCeiling(-1, maxShard))
	require.Equal(t, hard, shardStreamCeiling(0, maxShard))
	// A Config built without Load carries no shard size. The ceiling falls back to
	// the default config.Load would apply, not to the framing overhead, which
	// would refuse every shard over 1 MiB for reasons no operator could see.
	require.Equal(t, config.DefaultMaxShardBytes+shardStreamOverheadBytes,
		shardStreamCeiling(-1, 0))
}
