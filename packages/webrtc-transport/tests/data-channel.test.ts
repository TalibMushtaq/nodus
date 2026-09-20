import { describe, expect, it } from "vitest";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import { receiveShard, requestShard, sendShard, sendShardData } from "../src/data-channel.js";
import { MockRTCDataChannel } from "./mock-datachannel.js";

describe("WebRTC DataChannel shard transport", () => {
  it("successfully sends and receives a small shard with BLAKE3 validation", async () => {
    const [senderChan, receiverChan] = MockRTCDataChannel.createPair();

    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const hash = bytesToHex(blake3(payload));

    const sendPromise = sendShard(senderChan as unknown as RTCDataChannel, {
      transferId: "tr-001",
      fileId: "00000000-0000-0000-0000-000000000001",
      versionNumber: 1,
      shardIndex: 0,
      data: payload,
      hash,
    });

    const recvPromise = receiveShard({
      channel: receiverChan as unknown as RTCDataChannel,
      expectedHash: hash,
      expectedSize: payload.byteLength,
    });

    const [ack, result] = await Promise.all([sendPromise, recvPromise]);

    expect(ack.status).toBe("verified");
    expect(ack.transfer_id).toBe("tr-001");
    expect(result.data).toEqual(payload);
    expect(result.ack.status).toBe("verified");
    expect(result.metadata.file_id).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("successfully transfers multi-chunk shard (larger than 16KB)", async () => {
    const [senderChan, receiverChan] = MockRTCDataChannel.createPair();

    // 64 KB test payload
    const payload = new Uint8Array(64 * 1024);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = i % 256;
    }
    const hash = bytesToHex(blake3(payload));

    const sendPromise = sendShard(senderChan as unknown as RTCDataChannel, {
      transferId: "tr-002",
      fileId: "00000000-0000-0000-0000-000000000002",
      versionNumber: 1,
      shardIndex: 3,
      data: payload,
      hash,
    });

    const recvPromise = receiveShard({
      channel: receiverChan as unknown as RTCDataChannel,
      expectedHash: hash,
      expectedSize: payload.byteLength,
    });

    const [ack, result] = await Promise.all([sendPromise, recvPromise]);

    expect(ack.status).toBe("verified");
    expect(result.data.byteLength).toBe(64 * 1024);
    expect(bytesToHex(blake3(result.data))).toBe(hash);
  });

  it("emits the canonical shard_done marker required by the Rust receiver", async () => {
    // Guards the cross-stack frame contract: the Rust Storage Node's
    // `is_shard_done` only recognises `{"shard_done": true}`, so a `type`-keyed
    // marker would leave an upload hanging until its ack timeout.
    const [senderChan, receiverChan] = MockRTCDataChannel.createPair();
    const textFrames: string[] = [];
    receiverChan.on("message", (ev: MessageEvent) => {
      if (typeof ev.data === "string") textFrames.push(ev.data);
    });

    const payload = new Uint8Array([1, 2, 3]);
    const hash = bytesToHex(blake3(payload));

    const sendPromise = sendShard(senderChan as unknown as RTCDataChannel, {
      transferId: "tr-done",
      fileId: "00000000-0000-0000-0000-00000000000d",
      versionNumber: 1,
      shardIndex: 0,
      data: payload,
      hash,
    });
    const recvPromise = receiveShard({
      channel: receiverChan as unknown as RTCDataChannel,
      expectedHash: hash,
      expectedSize: payload.byteLength,
    });

    await Promise.all([sendPromise, recvPromise]);
    expect(textFrames).toContain(JSON.stringify({ shard_done: true }));
  });

  it("fails verification and throws on BLAKE3 hash mismatch", async () => {
    const [senderChan, receiverChan] = MockRTCDataChannel.createPair();

    const payload = new Uint8Array([10, 20, 30, 40]);
    const corruptedHash = "0000000000000000000000000000000000000000000000000000000000000000";

    const sendPromise = sendShard(senderChan as unknown as RTCDataChannel, {
      transferId: "tr-003",
      fileId: "00000000-0000-0000-0000-000000000003",
      versionNumber: 1,
      shardIndex: 0,
      data: payload,
      hash: corruptedHash,
    });

    const recvPromise = receiveShard({
      channel: receiverChan as unknown as RTCDataChannel,
      expectedHash: corruptedHash,
      expectedSize: payload.byteLength,
    });

    await expect(Promise.all([sendPromise, recvPromise])).rejects.toThrow();
  });
});

describe("WebRTC DataChannel shard fetch (download direction)", () => {
  it("requests and receives a stored shard with BLAKE3 validation", async () => {
    const [nodeChan, clientChan] = MockRTCDataChannel.createPair();

    const payload = new Uint8Array(48 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) % 256;
    const hash = bytesToHex(blake3(payload));

    // Start the requester first so its listeners are attached before the node's
    // header/first chunk can be delivered.
    const recvPromise = requestShard(clientChan as unknown as RTCDataChannel, {
      transferId: "tr-fetch-1",
      fileId: "00000000-0000-0000-0000-0000000000f1",
      versionNumber: 2,
      shardIndex: 5,
      hash,
      size: payload.byteLength,
    });
    await Promise.resolve();
    const sendPromise = sendShardData(nodeChan as unknown as RTCDataChannel, {
      transferId: "tr-fetch-1",
      hash,
      data: payload,
    });

    const [received] = await Promise.all([recvPromise, sendPromise]);
    expect(received.byteLength).toBe(payload.byteLength);
    expect(bytesToHex(blake3(received))).toBe(hash);
  });

  it("reports cumulative bytes for each received chunk", async () => {
    const [nodeChan, clientChan] = MockRTCDataChannel.createPair();

    const payload = new Uint8Array(40 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const hash = bytesToHex(blake3(payload));

    const progress: number[] = [];
    const recvPromise = requestShard(clientChan as unknown as RTCDataChannel, {
      transferId: "tr-fetch-progress",
      fileId: "00000000-0000-0000-0000-0000000000f4",
      versionNumber: 1,
      shardIndex: 0,
      hash,
      size: payload.byteLength,
      onProgress: (received) => progress.push(received),
    });
    await Promise.resolve();
    const sendPromise = sendShardData(nodeChan as unknown as RTCDataChannel, {
      transferId: "tr-fetch-progress",
      hash,
      data: payload,
    });
    await Promise.all([recvPromise, sendPromise]);

    // One report per chunk, strictly increasing, ending at the full size.
    expect(progress.length).toBeGreaterThan(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress[progress.length - 1]).toBe(payload.byteLength);
  });

  it("rejects when the node reports a fetch error", async () => {
    const [nodeChan, clientChan] = MockRTCDataChannel.createPair();

    const recvPromise = requestShard(clientChan as unknown as RTCDataChannel, {
      transferId: "tr-fetch-2",
      fileId: "00000000-0000-0000-0000-0000000000f2",
      versionNumber: 1,
      shardIndex: 0,
      hash: "00".repeat(32),
      size: 10,
    });
    await Promise.resolve();
    nodeChan.send(JSON.stringify({ shard_data_error: true, error_message: "not stored" }));

    await expect(recvPromise).rejects.toThrow("not stored");
  });

  it("sends the canonical shard-data frame markers the Rust node mirrors", async () => {
    const [nodeChan, clientChan] = MockRTCDataChannel.createPair();
    const textFrames: string[] = [];
    clientChan.on("message", (ev: MessageEvent) => {
      if (typeof ev.data === "string") textFrames.push(ev.data);
    });

    const payload = new Uint8Array([9, 8, 7]);
    const hash = bytesToHex(blake3(payload));

    const recvPromise = requestShard(clientChan as unknown as RTCDataChannel, {
      transferId: "tr-fetch-3",
      fileId: "00000000-0000-0000-0000-0000000000f3",
      versionNumber: 1,
      shardIndex: 1,
      hash,
      size: payload.byteLength,
    });
    await Promise.resolve();
    const sendPromise = sendShardData(nodeChan as unknown as RTCDataChannel, {
      transferId: "tr-fetch-3",
      hash,
      data: payload,
    });
    await Promise.all([recvPromise, sendPromise]);

    const parsed = textFrames.map((frame) => JSON.parse(frame));
    expect(parsed).toContainEqual(
      expect.objectContaining({ shard_data: true, hash }),
    );
    expect(parsed).toContainEqual({ shard_data_done: true });
  });
});
