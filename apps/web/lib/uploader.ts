// Path C client uploader: shard an encrypted file, emit the catalog sync
// events the Relay needs, and POST each encrypted shard into the Relay buffer.
//
// Two passes over the File (not two buffers):
//   pass 1 — hash plaintext + count shards, then per-shard encryption and
//            upload. A `FILE_VERSION_ADDED` event needs `shard_count` and a
//            whole-file `version_hash` *before* any shard is accepted
//            (buffer_upload.go requires the file_versions row), so the first
//            pass is unavoidable. It reads sequentially and discards each
//            chunk, so peak memory stays at one shard; the cost is one extra
//            disk/blob read per file.
//
// The FEK is persisted *before* the events are emitted (via deps.putFileKey):
// without that gate a reload would leave ciphertext whose key no longer exists.
//
// All side effects are injected through `UploadDeps` so the browser hook and
// the Node e2e harness share this exact code with different storage backends.

import {
  SHARD_SIZE_BYTES,
  createPlaintextHasher,
  encryptName,
  encryptShard,
  generateFileEncryptionKey,
  hashShard,
  packEncryptedShard,
} from "@repo/core";
import type { FileId, ShardIndex } from "@repo/core";
import { EventTypes } from "@repo/protocol";
import type { BatchAckPayload, EventPayload } from "@repo/protocol";

import type { ShardUpload, ShardUploadResult } from "./buffer";
import type { UploadProgress } from "./upload-progress";
import { uploadKey } from "./upload-progress";

export interface UploadDeps {
  postShard(dto: ShardUpload): Promise<ShardUploadResult>;
  /** Resolve with the batch ack; reject/throw to abort the upload. */
  sendEventBatch(events: EventPayload[]): Promise<BatchAckPayload | void>;
  allocateSequence(originId: string): Promise<number>;
  putFileKey(fileId: string, fek: Uint8Array): Promise<void>;
  getFileKey(fileId: string): Promise<Uint8Array | undefined>;
  saveProgress(progress: UploadProgress): Promise<void>;
  getProgress(fileId: string, versionNumber: number): Promise<UploadProgress | undefined>;
  markShardComplete(fileId: string, versionNumber: number, shardIndex: number): Promise<void>;
  clearProgress?(fileId: string, versionNumber: number): Promise<void>;
  /**
   * Seal + publish the FEK for the account's other devices/nodes (§25 F2).
   * Called after the file/version events are announced (so the FK target
   * exists) and on every resume, so a transient failure is retried.
   */
  publishEnvelopes?(fileId: string, fek: Uint8Array): Promise<void>;
}

export interface UploadFileOptions {
  file: File;
  /** The emitting device id — becomes each event's origin_id. */
  originId: string;
  targetNode: string;
  sourceDevice?: string;
  fileId?: string;
  versionNumber?: number;
  deps: UploadDeps;
  onProgress?: (event: UploadProgressEvent) => void;
}

export type UploadPhase = "measuring" | "announcing" | "uploading" | "done";

export interface UploadProgressEvent {
  phase: UploadPhase;
  completedShards: number;
  totalShards: number;
}

export interface UploadResult {
  fileId: string;
  versionNumber: number;
  shardCount: number;
  versionHash: string;
  resumed: boolean;
}

function event(originId: string, sequence: number, type: EventPayload["type"], payload: Record<string, unknown>): EventPayload {
  return {
    event_id: crypto.randomUUID() as EventPayload["event_id"],
    origin_id: originId,
    origin_sequence: sequence,
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Upload one file. Idempotent-by-resume: an incomplete progress record with a
 * persisted FEK skips pass 1, re-emits events only if they were never acked,
 * and re-sends only the shards not yet RELAY_BUFFERED.
 */
export async function uploadFile(options: UploadFileOptions): Promise<UploadResult> {
  const { file, originId, targetNode, sourceDevice, deps, onProgress } = options;
  const fileId = options.fileId ?? crypto.randomUUID();
  const versionNumber = options.versionNumber ?? 1;
  const transferId = uploadKey(fileId, versionNumber);
  const fileSize = file.size;

  const existing = await deps.getProgress(fileId, versionNumber);
  const existingKey = await deps.getFileKey(fileId);

  let fek: Uint8Array;
  let totalShards: number;
  let versionHash: string;
  let encryptedName: string;
  let announced: boolean;
  let completedShards: number[];
  let resumed = false;

  if (existing && existingKey && existing.totalShards > 0) {
    // Resume. A complete record is a no-op so a retry after success is cheap.
    if (existing.completedShards.length >= existing.totalShards) {
      await deps.clearProgress?.(fileId, versionNumber);
      return { fileId, versionNumber, shardCount: existing.totalShards, versionHash: existing.versionHash, resumed: true };
    }
    fek = existingKey;
    totalShards = existing.totalShards;
    versionHash = existing.versionHash;
    encryptedName = existing.encryptedName;
    announced = existing.announced;
    completedShards = [...existing.completedShards];
    resumed = true;
  } else {
    // Pass 1: measure shard count and hash the plaintext in one sequential read.
    fek = generateFileEncryptionKey();
    const hasher = createPlaintextHasher();
    let count = 0;
    for (let offset = 0; offset < fileSize; offset += SHARD_SIZE_BYTES) {
      const chunk = new Uint8Array(await file.slice(offset, offset + SHARD_SIZE_BYTES).arrayBuffer());
      hasher.update(chunk);
      count += 1;
      onProgress?.({ phase: "measuring", completedShards: 0, totalShards: count });
    }
    // An empty file still needs one (zero-length) shard to satisfy shard_count >= 1.
    totalShards = Math.max(1, count);
    versionHash = hasher.digest();
    encryptedName = encryptName(file.name, fek);
    announced = false;
    completedShards = [];

    // Durability gate: persist the FEK before anything references the file.
    await deps.putFileKey(fileId, fek);
    await deps.saveProgress({
      transferId,
      fileId,
      versionNumber,
      targetNode,
      totalShards,
      versionHash,
      encryptedName,
      announced: false,
      completedShards: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  if (!announced) {
    onProgress?.({ phase: "announcing", completedShards: completedShards.length, totalShards });
    const created = await deps.allocateSequence(originId);
    const version = await deps.allocateSequence(originId);
    const ack = await deps.sendEventBatch([
      event(originId, created, EventTypes.FILE_CREATED, { file_id: fileId, encrypted_name: encryptedName }),
      event(originId, version, EventTypes.FILE_VERSION_ADDED, {
        file_id: fileId,
        version_number: versionNumber,
        shard_count: totalShards,
        version_hash: versionHash,
        encrypted_name: encryptedName,
      }),
    ]);
    if (ack && ack.ok === false) {
      throw new Error(`sync event batch rejected: ${ack.reason ?? "unknown"}`);
    }
    await deps.saveProgress({
      transferId,
      fileId,
      versionNumber,
      targetNode,
      totalShards,
      versionHash,
      encryptedName,
      announced: true,
      completedShards,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  // Distribute the FEK before shards move, so any recipient that observes the
  // file can decrypt. Runs on every attempt (including resume) for retryability.
  await deps.publishEnvelopes?.(fileId, fek);

  // Pass 2: encrypt + upload the shards not already buffered.
  const done = new Set(completedShards);
  for (let index = 0; index < totalShards; index += 1) {
    if (done.has(index)) continue;
    const offset = index * SHARD_SIZE_BYTES;
    const chunk = new Uint8Array(await file.slice(offset, Math.min(offset + SHARD_SIZE_BYTES, fileSize)).arrayBuffer());
    const encrypted = encryptShard({ fileId: fileId as FileId, index: index as ShardIndex, data: chunk }, fek);
    // The stored/uploaded blob is nonce||ciphertext; the nonce must travel with
    // the bytes or the shard can never be decrypted again (F2b).
    const packed = packEncryptedShard(encrypted);

    await deps.postShard({
      fileId,
      versionNumber,
      shardIndex: index,
      hash: hashShard(packed),
      // The Relay verifies the packed blob's length/hash, not the plaintext size.
      size: packed.length,
      targetNode,
      transferId,
      sourceDevice,
      data: packed,
    });
    await deps.markShardComplete(fileId, versionNumber, index);
    done.add(index);
    onProgress?.({ phase: "uploading", completedShards: done.size, totalShards });
  }

  await deps.clearProgress?.(fileId, versionNumber);
  onProgress?.({ phase: "done", completedShards: totalShards, totalShards });
  return { fileId, versionNumber, shardCount: totalShards, versionHash, resumed };
}
