// Pure file-row projections for the mobile Files UI.
//
// Ported from the web `lib/file-view.ts` so both clients label storage the same
// way: "Synced" alone hid whether bytes were durably on a node or merely in the
// Relay buffer. Kept React-free so it can be unit-tested.

import { shortId, toCatalogEntry, type CatalogEntry } from "@repo/sdk";

import type { RelayFile } from "../relay";
import type { SyncStatus } from "../design";

/** Coarse location of the latest version, for an unambiguous UI label. */
export type FileStorageState = "node" | "relay" | "transferring" | "local" | "conflict";

export interface FileRow {
  fileId: string;
  /** Decrypted name, or a short id-derived fallback when no key is available. */
  name: string;
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
  status: SyncStatus;
  storageState: FileStorageState;
  parentFolderId: string | null;
  latestVersionNumber: number | null;
  shardCount: number | null;
  versionHash: string | null;
  encryptedName: string | null;
  conflictedVersions: number[];
  conflictedName: string | null;
  /** True when every latest-version shard is committed on a node. */
  downloadable: boolean;
  /** The original relay file, needed by download/rename/move/delete actions. */
  file: RelayFile;
}

export function fileStorageState(entry: CatalogEntry): FileStorageState {
  // Conflicts are identified by flagged versions, not by `conflict_status`:
  // the Relay uses "flagged"/"resolved" there, so a substring check would never
  // match (the web client has this same latent bug).
  if (entry.conflicted_versions.length > 0) {
    return "conflict";
  }
  switch (entry.storage_status) {
    case "stored":
      return "node";
    case "buffered":
      return "relay";
    case "transferring":
      return "transferring";
    default:
      return "local";
  }
}

/** Map the storage state onto the shared status vocabulary. */
export function toSyncStatus(entry: CatalogEntry): SyncStatus {
  switch (fileStorageState(entry)) {
    case "node":
      return "synced";
    case "relay":
    case "transferring":
      return "pending";
    case "conflict":
      return "conflict";
    case "local":
    default:
      // No version/locations yet (or an unrecognized Relay status): treat as
      // device-local rather than overstating that it is safely stored.
      return "local-only";
  }
}

export function latestSize(entry: CatalogEntry): number | null {
  if (entry.latest_version_number == null) return null;
  const rows = entry.locations.filter(
    (location) =>
      location.version_number === entry.latest_version_number && location.size_bytes != null,
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
          location.version_number === entry.latest_version_number &&
          location.status === "NODE_STORED",
      )
      .map((location) => location.shard_index),
  );
  for (let index = 0; index < entry.shard_count; index += 1) {
    if (!stored.has(index)) return false;
  }
  return true;
}

/** Flatten a relay file plus its resolved display name into a UI row. */
export function toFileRow(file: RelayFile, name: string | null): FileRow {
  const entry = toCatalogEntry(file);
  return {
    fileId: entry.file_id,
    name: name ?? shortId(entry.file_id),
    sizeBytes: latestSize(entry),
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
    status: toSyncStatus(entry),
    storageState: fileStorageState(entry),
    parentFolderId: entry.parent_folder_id,
    latestVersionNumber: entry.latest_version_number,
    shardCount: entry.shard_count,
    versionHash: entry.version_hash,
    encryptedName: entry.encrypted_name,
    conflictedVersions: entry.conflicted_versions,
    conflictedName: entry.conflicted_name,
    downloadable: isDownloadable(entry),
    file,
  };
}
