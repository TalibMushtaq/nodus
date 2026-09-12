// Browser-side folder tree access. Fetches GET /api/folders (Next's session
// proxy to the Relay) and caches the result in IndexedDB.

import type { RelayFolder } from "./catalog";
import { upsertFolders } from "./catalog";

export async function fetchFolders(): Promise<RelayFolder[]> {
  const res = await fetch("/api/folders");
  if (!res.ok) {
    throw new Error(`failed to load folders: ${res.status}`);
  }
  return (await res.json()) as RelayFolder[];
}

/** Fetch the folder tree and refresh the local cache. */
export async function refreshFolders(): Promise<RelayFolder[]> {
  const folders = await fetchFolders();
  await upsertFolders(folders);
  return folders;
}
