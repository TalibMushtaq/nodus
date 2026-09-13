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
  markShardComplete(fileId: string, versionNumber: number, shardIndex: number, hash: string): Promise<void>;
  clearProgress?(fileId: string, versionNumber: number): Promise<void>;
  /**
   * Sign the per-shard integrity manifest with the device key (audit #22).
   * When absent, no manifest event is emitted and the node falls back to
   * content-addressing only. Returns a hex Ed25519 signature over the canonical
   * `"nodus-shard-manifest:v1:{file_id}:{version}:{blake3(hashes.join(','))}"`.
   */
  signManifest?: (message: string) => string | Promise<string>;
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
  /** Precomputed plaintext hash from `measurePlaintext` (skips the measure pass). */
  versionHash?: string;
  /** Precomputed shard count from `measurePlaintext`. */
  shardCount?: number;
  /** Folder the file belongs to; null/undefined places it at the root. */
  parentFolderId?: string | null;
  deps: UploadDeps;
  onProgress?: (event: UploadProgressEvent) => void;
}

/** Result of one sequential read that hashes the plaintext and counts shards. */
export interface FileMeasurement {
  /** BLAKE3 hex of the whole plaintext version. */
  versionHash: string;
  /** Shard count for the version (>= 1 even for an empty file). */
  shardCount: number;
}

/**
 * Hash the plaintext and count shards in one sequential read.
 *
 * Exposed so the upload UI can detect a duplicate (same content already stored)
 * before committing, then hand the measurement to `uploadFile` so the bytes are
 * not read a second time. An empty file still measures one zero-length shard to
 * satisfy `shard_count >= 1`.
 */
export async function measurePlaintext(
  file: File,
  onProgress?: (event: UploadProgressEvent) => void,
): Promise<FileMeasurement> {
  const hasher = createPlaintextHasher();
  let count = 0;
  let bytesRead = 0;
  for (let offset = 0; offset < file.size; offset += SHARD_SIZE_BYTES) {
    const chunk = new Uint8Array(await file.slice(offset, offset + SHARD_SIZE_BYTES).arrayBuffer());
    hasher.update(chunk);
    count += 1;
    bytesRead += chunk.length;
    onProgress?.({
      phase: "measuring",
      // The file id is not allocated yet; the consumer attributes progress by
      // the active task, so an empty id is fine during the measure pass.
      fileId: "",
      fileName: file.name,
      completedBytes: bytesRead,
      totalBytes: file.size,
      completedShards: count,
      totalShards: count,
    });
  }
  return { versionHash: hasher.digest(), shardCount: Math.max(1, count) };
}

export type UploadPhase = "measuring" | "announcing" | "uploading" | "done";

/** Byte-accurate progress event. `completedBytes` drives the bar and speed. */
export interface UploadProgressEvent {
  phase: UploadPhase;
  /** Empty during the measure pass (the file id does not exist yet). */
  fileId: string;
  fileName: string;
  /** Plaintext bytes processed/uploaded so far. */
  completedBytes: number;
  /** Plaintext size of the whole file. */
  totalBytes: number;
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
  const parentFolderId = options.parentFolderId ?? null;
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
  /** BLAKE3 hex of each uploaded packed shard, indexed by shard index. */
  let shardHashes: string[];
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
    // Older progress records predate per-shard hashes; an empty list simply
    // means the manifest cannot be emitted for this resume.
    shardHashes = existing.shardHashes ? [...existing.shardHashes] : [];
    resumed = true;
  } else {
    fek = generateFileEncryptionKey();
    // Reuse a caller-supplied measurement (the Files UI measures once to dedupe)
    // so an accepted upload does not read the plaintext a second time.
    const measured =
      options.versionHash !== undefined && options.shardCount !== undefined
        ? { versionHash: options.versionHash, shardCount: options.shardCount }
        : await measurePlaintext(file, onProgress);
    totalShards = measured.shardCount;
    versionHash = measured.versionHash;
    encryptedName = encryptName(file.name, fek);
    announced = false;
    completedShards = [];
    shardHashes = [];

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
    onProgress?.({
      phase: "announcing",
      fileId,
      fileName: file.name,
      completedBytes: 0,
      totalBytes: fileSize,
      completedShards: completedShards.length,
      totalShards,
    });
    const created = await deps.allocateSequence(originId);
    const version = await deps.allocateSequence(originId);
    const ack = await deps.sendEventBatch([
      // parent_folder_id is projected by the FILE_CREATED upsert on both the
      // Relay and the node; FILE_VERSION_ADDED carries it too so a receiver
      // that first learns of the file from the version event still nests it.
      event(originId, created, EventTypes.FILE_CREATED, {
        file_id: fileId,
        parent_folder_id: parentFolderId,
        encrypted_name: encryptedName,
      }),
      event(originId, version, EventTypes.FILE_VERSION_ADDED, {
        file_id: fileId,
        parent_folder_id: parentFolderId,
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
  // Plaintext bytes already committed by a prior attempt, so a resumed upload's
  // progress starts where it left off instead of at zero.
  let committedBytes = Math.min(done.size * SHARD_SIZE_BYTES, fileSize);
  for (let index = 0; index < totalShards; index += 1) {
    if (done.has(index)) continue;
    const offset = index * SHARD_SIZE_BYTES;
    const chunk = new Uint8Array(await file.slice(offset, Math.min(offset + SHARD_SIZE_BYTES, fileSize)).arrayBuffer());
    const encrypted = encryptShard({ fileId: fileId as FileId, index: index as ShardIndex, data: chunk }, fek);
    // The stored/uploaded blob is nonce||ciphertext; the nonce must travel with
    // the bytes or the shard can never be decrypted again (F2b).
    const packed = packEncryptedShard(encrypted);
    const shardHash = hashShard(packed);

    await deps.postShard({
      fileId,
      versionNumber,
      shardIndex: index,
      hash: shardHash,
      // The Relay verifies the packed blob's length/hash, not the plaintext size.
      size: packed.length,
      targetNode,
      transferId,
      sourceDevice,
      data: packed,
      // In-shard byte progress. Path C (Relay XHR) and the WebRTC paths report
      // it; Path D (deferred queue) cannot and simply omits it, so the bar
      // advances by whole shards there.
      onProgress: (sentBytes) => {
        onProgress?.({
          phase: "uploading",
          fileId,
          fileName: file.name,
          completedBytes: Math.min(committedBytes + sentBytes, fileSize),
          totalBytes: fileSize,
          completedShards: done.size,
          totalShards,
        });
      },
    });
    await deps.markShardComplete(fileId, versionNumber, index, shardHash);
    shardHashes[index] = shardHash;
    done.add(index);
    committedBytes = Math.min(done.size * SHARD_SIZE_BYTES, fileSize);
    onProgress?.({
      phase: "uploading",
      fileId,
      fileName: file.name,
      completedBytes: committedBytes,
      totalBytes: fileSize,
      completedShards: done.size,
      totalShards,
    });
  }

  // Publish the signed per-shard manifest once every shard is buffered (audit
  // #22). Runs on every attempt, including a resume, so a manifest lost to a
  // crash is retried; the node upserts it and re-checks already-stored shards.
  if (deps.signManifest) {
    const hashes = Array.from({ length: totalShards }, (_, i) => shardHashes[i]);
    if (hashes.every((h): h is string => typeof h === "string")) {
      const manifestHash = hashShard(new TextEncoder().encode(hashes.join(",")));
      const signature = await deps.signManifest(
        `nodus-shard-manifest:v1:${fileId}:${versionNumber}:${manifestHash}`,
      );
      const sequence = await deps.allocateSequence(originId);
      const ack = await deps.sendEventBatch([
        event(originId, sequence, EventTypes.FILE_SHARD_MANIFEST, {
          file_id: fileId,
          version_number: versionNumber,
          shard_hashes: hashes,
          signature,
        }),
      ]);
      if (ack && ack.ok === false) {
        throw new Error(`shard manifest batch rejected: ${ack.reason ?? "unknown"}`);
      }
    }
  }

  await deps.clearProgress?.(fileId, versionNumber);
  onProgress?.({
    phase: "done",
    fileId,
    fileName: file.name,
    completedBytes: fileSize,
    totalBytes: fileSize,
    completedShards: totalShards,
    totalShards,
  });
  return { fileId, versionNumber, shardCount: totalShards, versionHash, resumed };
}
