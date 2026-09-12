// Browser-side file catalog access. Fetches GET /api/files (Next's session
// proxy to the Relay) and caches the result in IndexedDB so the dashboard can
// render offline-first and survive a reload.

import type { RelayFile } from "./catalog";
import { upsertCatalogEntries } from "./catalog";

export async function fetchFiles(): Promise<RelayFile[]> {
  const res = await fetch("/api/files");
  if (!res.ok) {
    throw new Error(`failed to load files: ${res.status}`);
  }
  return (await res.json()) as RelayFile[];
}

/** Fetch the catalog and refresh the local cache. Returns the fresh snapshot. */
export async function refreshCatalog(): Promise<RelayFile[]> {
  const files = await fetchFiles();
  await upsertCatalogEntries(files);
  return files;
}
