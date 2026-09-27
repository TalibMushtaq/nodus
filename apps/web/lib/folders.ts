// Browser-side folder tree access. Fetches GET /api/folders (Next's session
// proxy to the Relay) and caches the result in IndexedDB.

import type { RelayFolder } from "./catalog";
import { pruneFolders, upsertFolders } from "./catalog";
import { serialize } from "./serialize";

export async function fetchFolders(): Promise<RelayFolder[]> {
  const res = await fetch("/api/folders");
  if (!res.ok) {
    throw new Error(`failed to load folders: ${res.status}`);
  }
  return (await res.json()) as RelayFolder[];
}

/**
 * Fetch the folder tree and refresh the local cache. Serialized for the same
 * reason as `refreshCatalog`: overlapping runs must not interleave upsert/prune.
 */
export function refreshFolders(): Promise<RelayFolder[]> {
  return serialize("folders", async () => {
    const folders = await fetchFolders();
    await upsertFolders(folders);
    // Same reconciliation as the file catalog: prune folders the Relay dropped.
    await pruneFolders(new Set(folders.map((folder) => folder.folder_id)));
    return folders;
  });
}
