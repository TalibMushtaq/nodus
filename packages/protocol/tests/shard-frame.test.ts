import { describe, expect, it } from "vitest";

import {
  decodeShardFrame,
  encodeShardFrame,
  SHARD_FRAME_HEADER_BYTES,
  SHARD_FRAME_VERSION,
} from "../src/index.js";

// The Design A binary framing is the wire contract between the Go Relay and the
// Rust node; these lock the byte layout and the drop-malformed behavior both
// sides rely on for per-request routing.
describe("shard stream framing", () => {
  it("round-trips a request id and payload", () => {
    const payload = Uint8Array.from([1, 2, 3, 4]);
    const frame = encodeShardFrame("req-1", payload);
    expect(frame[0]).toBe(SHARD_FRAME_VERSION);
    expect(frame.length).toBe(SHARD_FRAME_HEADER_BYTES + "req-1".length + payload.length);

    const decoded = decodeShardFrame(frame);
    expect(decoded).not.toBeNull();
    expect(decoded!.requestId).toBe("req-1");
    expect(Array.from(decoded!.payload)).toEqual([1, 2, 3, 4]);
  });

  it("rejects malformed frames instead of misrouting", () => {
    expect(decodeShardFrame(new Uint8Array([]))).toBeNull();
    // Wrong version byte.
    expect(decodeShardFrame(Uint8Array.from([0x09, 0x00, 0x01, 0x61]))).toBeNull();
    // Length overruns the buffer.
    expect(decodeShardFrame(Uint8Array.from([SHARD_FRAME_VERSION, 0x00, 0x05, 0x61]))).toBeNull();
    // Zero-length id.
    expect(decodeShardFrame(Uint8Array.from([SHARD_FRAME_VERSION, 0x00, 0x00]))).toBeNull();
  });

  it("refuses to encode an empty request id", () => {
    expect(() => encodeShardFrame("", new Uint8Array([1]))).toThrow();
  });
});
