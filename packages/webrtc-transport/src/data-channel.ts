import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import {
  type ShardAckPayload,
  ShardAckPayloadSchema,
  ShardDataHeaderSchema,
  ShardFetchRequestPayloadSchema,
  type ShardUploadPayload,
  ShardUploadPayloadSchema,
  toProtocolFileId,
} from "@repo/protocol";
import {
  DataChannelIntegrityError,
  DataChannelTimeoutError,
  type ShardDataSendOptions,
  type ShardReceiveOptions,
  type ShardRequestOptions,
  type ShardSendOptions,
  WebRtcTransferError,
} from "./types.js";

export const CHUNK_SIZE = 16 * 1024; // 16 KB standard MTU chunk
const HIGH_WATER_MARK = 64 * 1024; // 64 KB buffer threshold
const DEFAULT_ACK_TIMEOUT_MS = 30_000;

/** Wait for a DataChannel to transition to the 'open' state */
export function waitForChannelOpen(channel: RTCDataChannel, timeoutMs = 5000): Promise<void> {
  if (channel.readyState === "open") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (ev: Event) => {
      cleanup();
      reject(new WebRtcTransferError("CHANNEL_ERROR", `DataChannel error: ${ev.type}`));
    };

    const onClose = () => {
      cleanup();
      reject(new WebRtcTransferError("CHANNEL_CLOSED", "DataChannel closed unexpectedly"));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new DataChannelTimeoutError("Timed out waiting for DataChannel to open"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("error", onError);
      channel.removeEventListener("close", onClose);
    };

    channel.addEventListener("open", onOpen);
    channel.addEventListener("error", onError);
    channel.addEventListener("close", onClose);
  });
}

/**
 * Send an encrypted shard over a WebRTC DataChannel following the Nodus frame protocol:
 * 1. [text frame] JSON: ShardUploadPayload
 * 2. [binary frames] 16 KB chunks of encrypted payload
 * 3. [text frame] JSON: { "shard_done": true }
 * 4. [text frame] JSON: ShardAckPayload (received from peer)
 *
 * The done marker is deliberately `{"shard_done": true}` and not a `type`
 * field: the Rust Storage Node's `is_shard_done` requires the explicit boolean
 * (services/storage-node/src/webrtc/session.rs) and ignores any other shape, so
 * a `{"type":"shard_done"}` frame would never end the transfer and only time
 * out. This is the single cross-stack contract both peers must agree on.
 */
export async function sendShard(
  channel: RTCDataChannel,
  opts: ShardSendOptions,
): Promise<ShardAckPayload> {
  await waitForChannelOpen(channel);
  channel.binaryType = "arraybuffer";

  // 1. Send ShardUploadPayload metadata text frame
  const uploadPayload: ShardUploadPayload = ShardUploadPayloadSchema.parse({
    file_id: toProtocolFileId(opts.fileId),
    version_number: opts.versionNumber,
    shard_index: opts.shardIndex,
    hash: opts.hash,
    size: opts.data.byteLength,
    transfer_id: opts.transferId,
    target_node: opts.targetNode,
    source_device: opts.sourceDevice,
  });

  channel.send(JSON.stringify(uploadPayload));

  // 2. Stream binary chunks with flow control
  let offset = 0;
  const total = opts.data.byteLength;

  while (offset < total) {
    // Flow control: pause if buffered amount exceeds threshold
    if (channel.bufferedAmount > HIGH_WATER_MARK) {
      await new Promise<void>((resolve) => {
        const onLow = () => {
          channel.removeEventListener("bufferedamountlow", onLow);
          resolve();
        };
        channel.bufferedAmountLowThreshold = HIGH_WATER_MARK / 2;
        channel.addEventListener("bufferedamountlow", onLow);
        setTimeout(() => {
          channel.removeEventListener("bufferedamountlow", onLow);
          resolve();
        }, 1000);
      });
    }

    const end = Math.min(offset + CHUNK_SIZE, total);
    const chunk = opts.data.subarray(offset, end);
    channel.send(chunk as unknown as ArrayBufferView<ArrayBuffer>);
    offset = end;
    opts.onProgress?.(offset, total);
  }

  // 3. Send done marker — see the frame-protocol note above for why the key
  // must be `shard_done: true` to interoperate with the Rust receiver.
  channel.send(JSON.stringify({ shard_done: true }));

  // 4. Await ShardAckPayload from receiver
  return await new Promise<ShardAckPayload>((resolve, reject) => {
    const onMessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        try {
          const parsed = JSON.parse(ev.data);
          const ack = ShardAckPayloadSchema.parse(parsed);
          cleanup();
          if (ack.status === "verified") {
            resolve(ack);
          } else {
            reject(
              new WebRtcTransferError(
                "VERIFICATION_FAILED",
                ack.error_message ?? `Shard ack reported status: ${ack.status}`,
              ),
            );
          }
        } catch {
          // Ignore unrelated or malformed intermediate messages
        }
      }
    };

    const onError = (ev: Event) => {
      cleanup();
      reject(new WebRtcTransferError("CHANNEL_ERROR", `DataChannel error awaiting ack: ${ev.type}`));
    };

    const onClose = () => {
      cleanup();
      reject(new WebRtcTransferError("CHANNEL_CLOSED", "DataChannel closed before receiving ack"));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new DataChannelTimeoutError("Timed out waiting for shard ack"));
    }, opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener("message", onMessage);
      channel.removeEventListener("error", onError);
      channel.removeEventListener("close", onClose);
    };

    channel.addEventListener("message", onMessage);
    channel.addEventListener("error", onError);
    channel.addEventListener("close", onClose);
  });
}

/**
 * Receive an encrypted shard from a WebRTC DataChannel:
 * Accumulates binary chunks until expected size / shard_done, verifies BLAKE3,
 * and sends back a ShardAckPayload.
 */
export async function receiveShard(opts: ShardReceiveOptions): Promise<{
  data: Uint8Array;
  metadata: ShardUploadPayload;
  ack: ShardAckPayload;
}> {
  const { channel, expectedHash, expectedSize, timeoutMs = DEFAULT_ACK_TIMEOUT_MS } = opts;
  await waitForChannelOpen(channel);
  channel.binaryType = "arraybuffer";

  return new Promise((resolve, reject) => {
    let metadata: ShardUploadPayload | null = null;
    const receivedChunks: Uint8Array[] = [];
    let receivedBytes = 0;

    const onMessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        try {
          const parsed = JSON.parse(ev.data);
          // Accept the canonical Rust-compatible marker plus the legacy
          // `{"type":"shard_done"}` shape so an old sender can still complete.
          if (parsed.shard_done === true || parsed.type === "shard_done") {
            handleDone();
          } else {
            // Must be ShardUploadPayload
            const meta = ShardUploadPayloadSchema.safeParse(parsed);
            if (meta.success) {
              metadata = meta.data;
            }
          }
        } catch {
          // Ignore
        }
      } else if (ev.data instanceof ArrayBuffer) {
        const chunk = new Uint8Array(ev.data);
        receivedChunks.push(chunk);
        receivedBytes += chunk.byteLength;
      } else if (ArrayBuffer.isView(ev.data)) {
        const chunk = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
        receivedChunks.push(chunk);
        receivedBytes += chunk.byteLength;
      }
    };

    const handleDone = () => {
      cleanup();

      // Concatenate received chunks
      const fullData = new Uint8Array(receivedBytes);
      let offset = 0;
      for (const chunk of receivedChunks) {
        fullData.set(chunk, offset);
        offset += chunk.byteLength;
      }

      // Compute BLAKE3
      const actualHash = bytesToHex(blake3(fullData));
      const targetHash = expectedHash || metadata?.hash || "";
      const targetSize = expectedSize || metadata?.size || 0;

      const fileId = metadata?.file_id ?? toProtocolFileId("00000000-0000-0000-0000-000000000000");
      const versionNumber = metadata?.version_number ?? 1;
      const shardIndex = metadata?.shard_index ?? 0;
      const transferId = metadata?.transfer_id ?? "00000000-0000-0000-0000-000000000000";

      if (
        (targetHash && actualHash !== targetHash) ||
        (targetSize > 0 && receivedBytes !== targetSize)
      ) {
        const failAck = ShardAckPayloadSchema.parse({
          file_id: fileId,
          version_number: versionNumber,
          shard_index: shardIndex,
          status: "failed",
          transfer_id: transferId,
          error_message: `Hash or size mismatch: got ${actualHash} (${receivedBytes}B), expected ${targetHash} (${targetSize}B)`,
        });
        try {
          channel.send(JSON.stringify(failAck));
        } catch {
          // Ignore
        }
        reject(
          new DataChannelIntegrityError(
            `Integrity check failed: got hash ${actualHash}, expected ${targetHash}`,
          ),
        );
        return;
      }

      const verifiedAck = ShardAckPayloadSchema.parse({
        file_id: fileId,
        version_number: versionNumber,
        shard_index: shardIndex,
        status: "verified",
        transfer_id: transferId,
      });

      try {
        channel.send(JSON.stringify(verifiedAck));
      } catch (err) {
        reject(new WebRtcTransferError("ACK_SEND_FAILED", `Failed to send verified ack: ${err}`));
        return;
      }

      const finalMeta: ShardUploadPayload = metadata ?? ShardUploadPayloadSchema.parse({
        file_id: fileId,
        version_number: versionNumber,
        shard_index: shardIndex,
        hash: actualHash,
        size: receivedBytes,
        transfer_id: transferId,
      });

      resolve({
        data: fullData,
        metadata: finalMeta,
        ack: verifiedAck,
      });
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new DataChannelTimeoutError("Timed out receiving shard data"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener("message", onMessage);
      channel.removeEventListener("error", onError);
      channel.removeEventListener("close", onClose);
    };

    const onError = (ev: Event) => {
      cleanup();
      reject(new WebRtcTransferError("CHANNEL_ERROR", `DataChannel error during receive: ${ev.type}`));
    };

    const onClose = () => {
      cleanup();
      reject(new WebRtcTransferError("CHANNEL_CLOSED", "DataChannel closed during receive"));
    };

    channel.addEventListener("message", onMessage);
    channel.addEventListener("error", onError);
    channel.addEventListener("close", onClose);
  });
}

/**
 * Request one stored shard and receive it over a DataChannel — the download
 * counterpart of `sendShard`. Frames: request text, then the node's
 * `shard_data` header, binary chunks, `shard_data_done`. The returned bytes are
 * BLAKE3-verified against the requested hash, so a corrupted/hostile stream is
 * rejected here rather than handed to the decryptor.
 */
export async function requestShard(
  channel: RTCDataChannel,
  opts: ShardRequestOptions,
): Promise<Uint8Array> {
  await waitForChannelOpen(channel);
  channel.binaryType = "arraybuffer";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let expectedHash = opts.hash;
    let expectedSize = opts.size;
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener("message", onMessage);
      channel.removeEventListener("error", onError);
      channel.removeEventListener("close", onClose);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new WebRtcTransferError("ABORTED", "shard fetch aborted"));
    };

    if (opts.signal?.aborted) {
      reject(new WebRtcTransferError("ABORTED", "shard fetch aborted"));
      return;
    }

    const finish = () => {
      cleanup();
      const full = new Uint8Array(receivedBytes);
      let offset = 0;
      for (const chunk of chunks) {
        full.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const actualHash = bytesToHex(blake3(full));
      if (actualHash !== expectedHash || (expectedSize > 0 && receivedBytes !== expectedSize)) {
        reject(
          new DataChannelIntegrityError(
            `Download integrity check failed: got ${actualHash} (${receivedBytes}B), expected ${expectedHash} (${expectedSize}B)`,
          ),
        );
        return;
      }
      resolve(full);
    };

    const onMessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        try {
          const parsed = JSON.parse(ev.data);
          // Explicit boolean markers, matching the Rust sender's contract.
          if (parsed.shard_data_done === true) {
            finish();
            return;
          }
          if (parsed.shard_data_error === true) {
            cleanup();
            reject(
              new WebRtcTransferError(
                "SHARD_FETCH_FAILED",
                typeof parsed.error_message === "string"
                  ? parsed.error_message
                  : "node refused the shard fetch",
              ),
            );
            return;
          }
          const header = ShardDataHeaderSchema.safeParse(parsed);
          if (header.success) {
            expectedHash = header.data.hash;
            expectedSize = header.data.size;
          }
        } catch {
          // Ignore malformed/unrelated frames.
        }
      } else if (ev.data instanceof ArrayBuffer) {
        chunks.push(new Uint8Array(ev.data));
        receivedBytes += ev.data.byteLength;
        opts.onProgress?.(receivedBytes, expectedSize);
      } else if (ArrayBuffer.isView(ev.data)) {
        const view = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
        chunks.push(view);
        receivedBytes += view.byteLength;
        opts.onProgress?.(receivedBytes, expectedSize);
      }
    };

    const onError = (ev: Event) => {
      cleanup();
      reject(new WebRtcTransferError("CHANNEL_ERROR", `DataChannel error during shard fetch: ${ev.type}`));
    };
    const onClose = () => {
      cleanup();
      reject(new WebRtcTransferError("CHANNEL_CLOSED", "DataChannel closed during shard fetch"));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new DataChannelTimeoutError("Timed out waiting for shard data"));
    }, timeoutMs);

    opts.signal?.addEventListener("abort", onAbort);
    channel.addEventListener("message", onMessage);
    channel.addEventListener("error", onError);
    channel.addEventListener("close", onClose);

    // Send the request only after the listeners are attached, so the node's
    // header/first chunk cannot arrive before we are ready to read it.
    const request = ShardFetchRequestPayloadSchema.parse({
      shard_fetch: true,
      file_id: toProtocolFileId(opts.fileId),
      version_number: opts.versionNumber,
      shard_index: opts.shardIndex,
      hash: opts.hash,
      size: opts.size,
      transfer_id: opts.transferId,
      source_node: opts.sourceNode,
    });
    try {
      channel.send(JSON.stringify(request));
    } catch (err) {
      cleanup();
      reject(new WebRtcTransferError("REQUEST_SEND_FAILED", `Failed to send shard request: ${err}`));
    }
  });
}

/**
 * Stream one stored shard back over a DataChannel — the node-side counterpart
 * of `requestShard`, kept here so the framing has a single TS definition and
 * the round-trip is testable without a Rust build.
 */
export async function sendShardData(
  channel: RTCDataChannel,
  opts: ShardDataSendOptions,
): Promise<void> {
  await waitForChannelOpen(channel);
  channel.binaryType = "arraybuffer";

  const header = ShardDataHeaderSchema.parse({
    shard_data: true,
    hash: opts.hash,
    size: opts.data.byteLength,
    transfer_id: opts.transferId,
  });
  channel.send(JSON.stringify(header));

  let offset = 0;
  const total = opts.data.byteLength;
  while (offset < total) {
    if (channel.bufferedAmount > HIGH_WATER_MARK) {
      await new Promise<void>((resolve) => {
        const onLow = () => {
          channel.removeEventListener("bufferedamountlow", onLow);
          resolve();
        };
        channel.bufferedAmountLowThreshold = HIGH_WATER_MARK / 2;
        channel.addEventListener("bufferedamountlow", onLow);
        setTimeout(() => {
          channel.removeEventListener("bufferedamountlow", onLow);
          resolve();
        }, 1000);
      });
    }
    const end = Math.min(offset + CHUNK_SIZE, total);
    channel.send(opts.data.subarray(offset, end) as unknown as ArrayBufferView<ArrayBuffer>);
    offset = end;
  }

  channel.send(JSON.stringify({ shard_data_done: true }));
}
