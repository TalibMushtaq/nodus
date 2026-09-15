// Resumable Path C upload progress (SQLite), mirroring the web IndexedDB store.
//
// Array fields are serialized as JSON text: SQLite has no array type, and the
// lists are small (shard indices / hashes) so the overhead is negligible.

import type { UploadProgress } from "@repo/sdk";

import { getDb } from "./db";

interface UploadRow {
  transfer_id: string;
  file_id: string;
  version_number: number;
  target_node: string;
  total_shards: number;
  version_hash: string;
  encrypted_name: string;
  shard_size_bytes: number | null;
  announced: number;
  completed_shards: string;
  shard_hashes: string | null;
  created_at: string;
  updated_at: string;
}

function toProgress(row: UploadRow): UploadProgress {
  return {
    transferId: row.transfer_id,
    fileId: row.file_id,
    versionNumber: row.version_number,
    targetNode: row.target_node,
    totalShards: row.total_shards,
    versionHash: row.version_hash,
    encryptedName: row.encrypted_name,
    shardSizeBytes: row.shard_size_bytes ?? undefined,
    announced: row.announced !== 0,
    completedShards: JSON.parse(row.completed_shards) as number[],
    shardHashes: row.shard_hashes ? (JSON.parse(row.shard_hashes) as string[]) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function saveUploadProgress(progress: UploadProgress): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO upload_progress
       (transfer_id, file_id, version_number, target_node, total_shards, version_hash,
        encrypted_name, shard_size_bytes, announced, completed_shards, shard_hashes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    progress.transferId,
    progress.fileId,
    progress.versionNumber,
    progress.targetNode,
    progress.totalShards,
    progress.versionHash,
    progress.encryptedName,
    progress.shardSizeBytes ?? null,
    progress.announced ? 1 : 0,
    JSON.stringify(progress.completedShards),
    progress.shardHashes ? JSON.stringify(progress.shardHashes) : null,
    progress.createdAt,
    progress.updatedAt,
  );
}

export async function getUploadProgress(
  fileId: string,
  versionNumber: number,
): Promise<UploadProgress | undefined> {
  const db = await getDb();
  const row = await db.getFirstAsync<UploadRow>(
    "SELECT * FROM upload_progress WHERE transfer_id = ?",
    `${fileId}:${versionNumber}`,
  );
  return row ? toProgress(row) : undefined;
}

/** Record one successfully buffered shard. Idempotent by index. */
export async function markShardComplete(
  fileId: string,
  versionNumber: number,
  shardIndex: number,
  hash?: string,
): Promise<void> {
  const progress = await getUploadProgress(fileId, versionNumber);
  if (!progress) return;
  let hashChanged = false;
  if (hash !== undefined) {
    progress.shardHashes ??= [];
    hashChanged = progress.shardHashes[shardIndex] !== hash;
    progress.shardHashes[shardIndex] = hash;
  }
  const newlyCompleted = !progress.completedShards.includes(shardIndex);
  if (newlyCompleted) {
    progress.completedShards.push(shardIndex);
    progress.completedShards.sort((a, b) => a - b);
  }
  if (hashChanged || newlyCompleted) {
    progress.updatedAt = new Date().toISOString();
    await saveUploadProgress(progress);
  }
}

export async function clearUploadProgress(fileId: string, versionNumber: number): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM upload_progress WHERE transfer_id = ?", `${fileId}:${versionNumber}`);
}
