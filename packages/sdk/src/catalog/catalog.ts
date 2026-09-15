// File/folder catalog projections, shared by web and native.
//
// The Relay returns a file with all of its versions and per-shard locations;
// the UI wants one flattened row per file with the latest version's metadata, a
// rollup storage status, and every flagged (conflicted) version. These
// projections are pure and identical on both clients; the platform owns caching
// them (IndexedDB / SQLite).

import type { RelayFileLocation } from "../download/download.js";

/** A file version as returned by the Relay. */
export interface RelayFileVersion {
  version_number: number;
  shard_count: number;
  version_hash: string;
  conflict_status: string;
  created_at: string;
}

/** One file with its versions and current locations (`GET /files`). */
export interface RelayFile {
  file_id: string;
  parent_folder_id: string | null;
  encrypted_name: string | null;
  created_at: string;
  updated_at: string;
  versions: RelayFileVersion[];
  locations: RelayFileLocation[];
}

/** Flattened, UI-friendly catalog row. */
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
  /**
   * Version numbers whose `conflict_status` is `flagged` (ADR-0003). The latest
   * version's status alone is not enough: a preserved sibling can be any
   * version, so the inbox needs every flagged version.
   */
  conflicted_versions: number[];
  /** Rollup of the latest version's location statuses. */
  storage_status: "stored" | "buffered" | "transferring" | "unknown" | null;
  /** Per-shard locations (all versions) — the download path's manifest. */
  locations: RelayFileLocation[];
  cached_at: string;
}

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

/** Latest version wins; ties (shouldn't happen) resolve to the highest number. */
function latestVersion(file: RelayFile): RelayFileVersion | null {
  if (file.versions.length === 0) return null;
  return file.versions.reduce((a, b) => (b.version_number > a.version_number ? b : a));
}

/**
 * Collapse per-shard location statuses into one label. Relay statuses are
 * free-text, so treat unknown values as "unknown" rather than guessing.
 */
function summarizeStorageStatus(
  file: RelayFile,
  latest: RelayFileVersion | null,
): CatalogEntry["storage_status"] {
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
    conflicted_versions: file.versions
      .filter((v) => v.conflict_status === "flagged")
      .map((v) => v.version_number)
      .sort((a, b) => a - b),
    storage_status: summarizeStorageStatus(file, latest),
    locations: file.locations,
    cached_at: new Date().toISOString(),
  };
}
