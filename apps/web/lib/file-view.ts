import type { SyncStatus } from "@repo/ui/primitives/badge";

import type { CatalogEntry, RelayFileLocation } from "./catalog";

/**
 * Pure projections from a cached catalog entry to the Files table. Kept free of
 * React/IndexedDB so they can be unit-tested directly; the async name
 * decryption lives in use-files.ts.
 */

export interface FileEntryView {
  fileId: string;
  /** Decrypted name, or a short id-derived fallback when no key is available. */
  name: string;
  /** Latest version's known shard bytes, or null when locations carry no size. */
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
  status: SyncStatus;
  latestVersionNumber: number | null;
  shardCount: number | null;
  versionHash: string | null;
  encryptedName: string | null;
  /** All shard locations (all versions) — the download manifest. */
  locations: RelayFileLocation[];
  /** True when every latest-version shard is committed on a node. */
  downloadable: boolean;
}

/** Map the Relay's storage/conflict rollup onto the app's status vocabulary. */
export function toSyncStatus(entry: CatalogEntry): SyncStatus {
  if (entry.conflict_status && entry.conflict_status.toUpperCase().includes("CONFLICT")) {
    return "conflict";
  }
  switch (entry.storage_status) {
    case "stored":
      return "synced";
    case "buffered":
    case "transferring":
      return "pending";
    default:
      // No version/locations yet (or an unrecognized Relay status): treat as
      // device-local rather than overstating that it is safely stored.
      return "local-only";
  }
}

export function latestSize(entry: CatalogEntry): number | null {
  if (entry.latest_version_number == null) return null;
  const rows = entry.locations.filter(
    (location) => location.version_number === entry.latest_version_number && location.size_bytes != null,
  );
  if (rows.length === 0) return null;
  return rows.reduce((sum, location) => sum + (location.size_bytes ?? 0), 0);
}

export function isDownloadable(entry: CatalogEntry): boolean {
  if (entry.latest_version_number == null || entry.shard_count == null) return false;
  const stored = new Set(
    entry.locations
      .filter(
        (location) =>
          location.version_number === entry.latest_version_number && location.status === "NODE_STORED",
      )
      .map((location) => location.shard_index),
  );
  for (let index = 0; index < entry.shard_count; index += 1) {
    if (!stored.has(index)) return false;
  }
  return true;
}
