// Browser-side file catalog access. Fetches GET /api/files (Next's session
// proxy to the Relay) and caches the result in IndexedDB so the dashboard can
// render offline-first and survive a reload.

import type { RelayFile } from "./catalog";
import { pruneCatalog, upsertCatalogEntries } from "./catalog";
import { serialize } from "./serialize";

export async function fetchFiles(): Promise<RelayFile[]> {
  const res = await fetch("/api/files");
  if (!res.ok) {
    throw new Error(`failed to load files: ${res.status}`);
  }
  return (await res.json()) as RelayFile[];
}

/**
 * Fetch the catalog and refresh the local cache. Returns the fresh snapshot.
 * Serialized (see `serialize`) because the mount/poll/push callers can overlap:
 * interleaved runs let an older snapshot's prune delete rows a newer run added.
 */
export function refreshCatalog(): Promise<RelayFile[]> {
  return serialize("catalog", async () => {
    const files = await fetchFiles();
    await upsertCatalogEntries(files);
    // Reconcile against the snapshot: drop files the Relay no longer reports so
    // the UI cannot render ghost rows from an earlier state/reset.
    await pruneCatalog(new Set(files.map((file) => file.file_id)));
    return files;
  });
}
