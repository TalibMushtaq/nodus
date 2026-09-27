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

import { STORE_UPLOAD_PROGRESS, idbDelete, idbGet, idbGetAll, idbPut, openWebDb } from "./db";
import { uploadKey, type UploadProgress } from "@repo/sdk";

// The record and its key are defined in @repo/sdk so web and native persist the
// same shape; this module adds the browser's IndexedDB accessors on top.
export { uploadKey };
export type { UploadProgress };

export async function saveUploadProgress(progress: UploadProgress): Promise<void> {
  await idbPut<UploadProgress>(STORE_UPLOAD_PROGRESS, progress);
}

export async function getUploadProgress(fileId: string, versionNumber: number): Promise<UploadProgress | undefined> {
  return idbGet<UploadProgress>(STORE_UPLOAD_PROGRESS, uploadKey(fileId, versionNumber));
}

/**
 * Record one successfully buffered shard. Idempotent by index.
 *
 * The read-modify-write runs in a single `readwrite` transaction: shards
 * complete concurrently during an upload, and a get-then-put across two
 * transactions would lose updates when two completions interleave (both read
 * the same set, the later put wins, and one index vanishes — causing a resume
 * to re-send a shard, or `listIncompleteUploads` to never drain).
 */
export async function markShardComplete(
  fileId: string,
  versionNumber: number,
  shardIndex: number,
  hash?: string,
): Promise<void> {
  const db = await openWebDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_UPLOAD_PROGRESS, "readwrite");
      const store = tx.objectStore(STORE_UPLOAD_PROGRESS);
      const request = store.get(uploadKey(fileId, versionNumber));
      request.onsuccess = () => {
        const progress = request.result as UploadProgress | undefined;
        if (!progress) return; // Nothing tracked for this version.
        let changed = false;
        if (hash !== undefined) {
          progress.shardHashes ??= [];
          if (progress.shardHashes[shardIndex] !== hash) {
            progress.shardHashes[shardIndex] = hash;
            changed = true;
          }
        }
        if (!progress.completedShards.includes(shardIndex)) {
          progress.completedShards.push(shardIndex);
          progress.completedShards.sort((a, b) => a - b);
          changed = true;
        }
        if (changed) {
          progress.updatedAt = new Date().toISOString();
          store.put(progress);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("upload progress write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("upload progress write aborted"));
    });
  } finally {
    db.close();
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
