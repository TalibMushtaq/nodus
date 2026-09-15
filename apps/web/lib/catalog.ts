// Cached file catalog for the web client. Populated from `GET /api/files`
// (Relay `GET /files`) so the dashboard can render without a round trip, and
// keyed by file_id for idempotent upserts. The stored `encrypted_name` is
// opaque here — callers decrypt it with the local FEK from lib/keys.ts.
//
// The types and the flattening projection (`toCatalogEntry`) live in @repo/sdk
// so web and native agree on storage status / conflict rollups; this module
// adds the browser's IndexedDB cache on top.

import { toCatalogEntry } from "@repo/sdk";
import type { CatalogEntry, FolderEntry, RelayFile, RelayFolder } from "@repo/sdk";

import { STORE_CATALOG, STORE_FOLDERS, idbDelete, idbGetAll, idbPut } from "./db";

export { toCatalogEntry };
export type {
  RelayFileVersion,
  RelayFileLocation,
  RelayFile,
  CatalogEntry,
  RelayFolder,
  FolderEntry,
} from "@repo/sdk";

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

/**
 * Remove cached files absent from the latest Relay snapshot.
 *
 * Upserting alone leaves entries the Relay has forgotten (deleted files, or a
 * cache populated before a relay/database reset) in the local DB, so the Files
 * UI kept rendering ghost rows as if they were still stored. Refresh is the
 * right place to reconcile the cache against the authoritative snapshot.
 */
export async function pruneCatalog(keepFileIds: Set<string>): Promise<void> {
  const cached = await idbGetAll<CatalogEntry>(STORE_CATALOG);
  for (const entry of cached) {
    if (!keepFileIds.has(entry.file_id)) {
      await idbDelete(STORE_CATALOG, entry.file_id);
    }
  }
}

// ── Folder tree (Phase 14 F1) ────────────────────────────────────────

export async function getCachedFolders(): Promise<FolderEntry[]> {
  const folders = await idbGetAll<FolderEntry>(STORE_FOLDERS);
  return folders.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function upsertFolders(folders: RelayFolder[]): Promise<void> {
  for (const folder of folders) {
    await idbPut<FolderEntry>(STORE_FOLDERS, { ...folder, cached_at: new Date().toISOString() });
  }
}

/** Remove cached folders absent from the latest Relay snapshot (see pruneCatalog). */
export async function pruneFolders(keepFolderIds: Set<string>): Promise<void> {
  const cached = await idbGetAll<FolderEntry>(STORE_FOLDERS);
  for (const folder of cached) {
    if (!keepFolderIds.has(folder.folder_id)) {
      await idbDelete(STORE_FOLDERS, folder.folder_id);
    }
  }
}
