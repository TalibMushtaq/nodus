// Resumable upload progress for Path C. A `FILE_VERSION_ADDED` event asserts a
// shard_count; this record tracks which shard indices have actually reached at
// least RELAY_BUFFERED (the Relay's 201 response), so a retry or a resumed
// session re-sends only the outstanding shards instead of the whole file.
//
// It also carries the version hash and encrypted name from pass 1, so a resume
// that crashed before the events were announced can re-emit them without
// re-reading the file. `announced` records whether the Relay has the
// file/version rows yet.
//
// Browser reload caveat: the File itself is not re-readable without the user
// re-selecting it (the File System Access API is not universal), so "resume"
// avoids re-uploading completed shards once the file is provided again. The
// Node e2e harness uses a file-backed store where the source survives a kill.

import { STORE_UPLOAD_PROGRESS, idbDelete, idbGet, idbGetAll, idbPut } from "./db";

export interface UploadProgress {
  /** `${fileId}:${versionNumber}` — the store's key. */
  transferId: string;
  fileId: string;
  versionNumber: number;
  targetNode: string;
  totalShards: number;
  /** BLAKE3 hex of the whole plaintext, from upload pass 1. */
  versionHash: string;
  /** FEK-encrypted filename (see @repo/core encryptName). */
  encryptedName: string;
  /** True once FILE_CREATED + FILE_VERSION_ADDED have been acknowledged. */
  announced: boolean;
  /** Shard indices confirmed RELAY_BUFFERED by a successful postShard. */
  completedShards: number[];
  createdAt: string;
  updatedAt: string;
}

export function uploadKey(fileId: string, versionNumber: number): string {
  return `${fileId}:${versionNumber}`;
}

export async function saveUploadProgress(progress: UploadProgress): Promise<void> {
  await idbPut<UploadProgress>(STORE_UPLOAD_PROGRESS, progress);
}

export async function getUploadProgress(fileId: string, versionNumber: number): Promise<UploadProgress | undefined> {
  return idbGet<UploadProgress>(STORE_UPLOAD_PROGRESS, uploadKey(fileId, versionNumber));
}

/** Record one successfully buffered shard. Idempotent by index. */
export async function markShardComplete(fileId: string, versionNumber: number, shardIndex: number): Promise<void> {
  const progress = await getUploadProgress(fileId, versionNumber);
  if (!progress) return;
  if (!progress.completedShards.includes(shardIndex)) {
    progress.completedShards.push(shardIndex);
    progress.completedShards.sort((a, b) => a - b);
    progress.updatedAt = new Date().toISOString();
    await saveUploadProgress(progress);
  }
}

export async function clearUploadProgress(fileId: string, versionNumber: number): Promise<void> {
  await idbDelete(STORE_UPLOAD_PROGRESS, uploadKey(fileId, versionNumber));
}

/** Uploads whose shard set is not yet complete. */
export async function listIncompleteUploads(): Promise<UploadProgress[]> {
  const records = await idbGetAll<UploadProgress>(STORE_UPLOAD_PROGRESS);
  return records.filter((r) => r.completedShards.length < r.totalShards);
}
