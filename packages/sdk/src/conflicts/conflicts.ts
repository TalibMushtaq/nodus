// Conflict inbox (ADR-0003), shared by web and native.
//
// The Relay's `GET /files` already returns a `conflict_status` per version, so
// the inbox is derived from the catalog — no new endpoint. A conflict renders
// with the decrypted name when this device can resolve the FEK, and a short id
// otherwise, so a missing envelope never hides a conflict.

import { decryptName } from "@repo/core";

import type { CatalogEntry } from "../catalog/catalog.js";
import { shortId } from "../format.js";

/** One file with at least one flagged (conflicted) version. */
export interface ConflictEntry {
  fileId: string;
  /** Decrypted display name when the FEK is available, else a short id. */
  name: string;
  versions: number[];
  updatedAt: string;
}

export interface ConflictDeps {
  listCatalog(): Promise<CatalogEntry[]>;
  /** This device's FEK for a file, or null when it has no envelope. */
  resolveFileKey(fileId: string): Promise<Uint8Array | null>;
}

async function resolveName(entry: CatalogEntry, deps: ConflictDeps): Promise<string> {
  if (!entry.encrypted_name) return shortId(entry.file_id);
  const fek = await deps.resolveFileKey(entry.file_id).catch(() => null);
  if (!fek) return `Encrypted · ${shortId(entry.file_id)}`;
  try {
    return decryptName(entry.encrypted_name, fek);
  } catch {
    return shortId(entry.file_id);
  }
}

/** Catalog files that have at least one `flagged` version, newest first. */
export async function listConflicts(deps: ConflictDeps): Promise<ConflictEntry[]> {
  const cached = await deps.listCatalog();
  const conflicted = cached.filter((entry) => entry.conflicted_versions.length > 0);
  const rows = await Promise.all(
    conflicted.map(async (entry) => ({
      fileId: entry.file_id,
      name: await resolveName(entry, deps),
      versions: entry.conflicted_versions,
      updatedAt: entry.updated_at,
    })),
  );
  return rows.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
}
