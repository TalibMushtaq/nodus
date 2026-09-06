import { describe, expect, it } from "vitest";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import { receiveShard, sendShard } from "../src/data-channel.js";
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
