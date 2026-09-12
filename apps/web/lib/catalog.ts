// Cached file catalog for the web client. Populated from `GET /api/files`
// (Relay `GET /files`) so the dashboard can render without a round trip, and
// keyed by file_id for idempotent upserts. The stored `encrypted_name` is
// opaque here — callers decrypt it with the local FEK from lib/keys.ts.

import { STORE_CATALOG, STORE_FOLDERS, idbGetAll, idbPut, idbClear } from "./db";

/** A file version as returned by the Relay. */
export interface RelayFileVersion {
  version_number: number;
  shard_count: number;
  version_hash: string;
  conflict_status: string;
  created_at: string;
}

/** A physical location row as returned by the Relay (file_locations). */
export interface RelayFileLocation {
  version_number: number;
  shard_index: number;
  node_id: string;
  status: string;
  /** BLAKE3 hex of the encrypted shard; null until the shard is uploaded. */
  hash: string | null;
  size_bytes: number | null;
}

/** One file with its versions and current locations (GET /files). */
export interface RelayFile {
  file_id: string;
  parent_folder_id: string | null;
  encrypted_name: string | null;
  created_at: string;
  updated_at: string;
  versions: RelayFileVersion[];
  locations: RelayFileLocation[];
}

/** Locally cached catalog row — a flattened, UI-friendly projection. */
export interface CatalogEntry {
  file_id: string;
  parent_folder_id: string | null;
  encrypted_name: string | null;
  created_at: string;
  updated_at: string;
  latest_version_number: number | null;
  shard_count: number | null;
  version_hash: string | null;
  conflict_status: string | null;
  /** Rollup of the latest version's location statuses. */
  storage_status: "stored" | "buffered" | "transferring" | "unknown" | null;
  /** Per-shard locations (all versions) — the download path's manifest. */
  locations: RelayFileLocation[];
  cached_at: string;
}

/** Latest version wins; ties (shouldn't happen) resolve to the highest number. */
function latestVersion(file: RelayFile): RelayFileVersion | null {
  if (file.versions.length === 0) return null;
  return file.versions.reduce((a, b) => (b.version_number > a.version_number ? b : a));
}

/**
 * Collapse per-shard location statuses into one label. Relay statuses are
 * free-text, so treat unknown values as "unknown" rather than guessing.
 */
function summarizeStorageStatus(file: RelayFile, latest: RelayFileVersion | null): CatalogEntry["storage_status"] {
  if (!latest) return null;
  const statuses = file.locations
    .filter((l) => l.version_number === latest.version_number)
    .map((l) => l.status);
  if (statuses.length === 0) return null;
  if (statuses.some((s) => s === "UPLOADING" || s === "RELAY_BUFFERED")) return "buffered";
  if (statuses.some((s) => s === "NODE_RECEIVING" || s === "NODE_VERIFIED")) return "transferring";
  if (statuses.every((s) => s === "NODE_STORED")) return "stored";
  return "unknown";
}

export function toCatalogEntry(file: RelayFile): CatalogEntry {
  const latest = latestVersion(file);
  return {
    file_id: file.file_id,
    parent_folder_id: file.parent_folder_id,
    encrypted_name: file.encrypted_name,
    created_at: file.created_at,
    updated_at: file.updated_at,
    latest_version_number: latest?.version_number ?? null,
    shard_count: latest?.shard_count ?? null,
    version_hash: latest?.version_hash ?? null,
    conflict_status: latest?.conflict_status ?? null,
    storage_status: summarizeStorageStatus(file, latest),
    locations: file.locations,
    cached_at: new Date().toISOString(),
  };
}

/** Newest-cached first, matching the devices/node list convention. */
export async function getCachedCatalog(): Promise<CatalogEntry[]> {
  const entries = await idbGetAll<CatalogEntry>(STORE_CATALOG);
  return entries.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
}

/** Upsert a whole catalog snapshot, one file at a time. */
export async function upsertCatalogEntries(files: RelayFile[]): Promise<void> {
  for (const file of files) {
    await idbPut<CatalogEntry>(STORE_CATALOG, toCatalogEntry(file));
  }
}

export async function clearCatalog(): Promise<void> {
  await idbClear(STORE_CATALOG);
}

// ── Folder tree (Phase 14 F1) ────────────────────────────────────────

/** A folder as returned by the Relay (`GET /folders`). */
export interface RelayFolder {
  folder_id: string;
  parent_folder_id: string | null;
  encrypted_name: string | null;
  created_at: string;
  updated_at: string;
}

/** Locally cached folder row. */
export interface FolderEntry extends RelayFolder {
  cached_at: string;
}

export async function getCachedFolders(): Promise<FolderEntry[]> {
  const folders = await idbGetAll<FolderEntry>(STORE_FOLDERS);
  return folders.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function upsertFolders(folders: RelayFolder[]): Promise<void> {
  for (const folder of folders) {
    await idbPut<FolderEntry>(STORE_FOLDERS, { ...folder, cached_at: new Date().toISOString() });
  }
}

export async function clearFolders(): Promise<void> {
  await idbClear(STORE_FOLDERS);
}
