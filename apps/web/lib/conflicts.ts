// Conflict inbox (ADR-0003). The Relay's `GET /files` already returns a
// `conflict_status` per version, so the web can list preserved conflicted
// copies without any new endpoint. This module derives the inbox from the
// cached catalog and decrypts display names the same way the Files page does.

import { decryptName } from "@repo/core";
import { identityPrivateKey } from "@repo/relay-client";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import { getCachedCatalog, type CatalogEntry } from "./catalog";
import { getFileKey } from "./keys";
import { fetchAndOpenFileKey } from "./envelopes";
import { shortId } from "./format";

/** One file with at least one flagged (conflicted) version. */
export interface ConflictEntry {
  fileId: string;
  /** Decrypted display name when the FEK is available, else a short id. */
  name: string;
  versions: number[];
  updatedAt: string;
}

/**
 * Decrypt a file's display name. Mirrors `use-files.ts`: prefer the local FEK,
 * fall back to the device's Relay key envelope, and never throw — a conflict
 * still renders with a short id when no key is available.
 */
async function resolveName(entry: CatalogEntry, device: StoredDeviceIdentity): Promise<string> {
  if (!entry.encrypted_name) return shortId(entry.file_id);
  let fek = await getFileKey(entry.file_id);
  if (!fek) {
    try {
      fek =
        (await fetchAndOpenFileKey(
          entry.file_id,
          device.device_id,
          identityPrivateKey(device),
        )) ?? undefined;
    } catch {
      fek = undefined;
    }
  }
  if (!fek) return `Encrypted · ${shortId(entry.file_id)}`;
  try {
    return decryptName(entry.encrypted_name, fek);
  } catch {
    return shortId(entry.file_id);
  }
}

/** Cached files that have at least one `flagged` version, newest first. */
export async function listConflicts(device: StoredDeviceIdentity): Promise<ConflictEntry[]> {
  const cached = await getCachedCatalog();
  const conflicted = cached.filter((entry) => entry.conflicted_versions.length > 0);
  const rows = await Promise.all(
    conflicted.map(async (entry) => ({
      fileId: entry.file_id,
      name: await resolveName(entry, device),
      versions: entry.conflicted_versions,
      updatedAt: entry.updated_at,
    })),
  );
  return rows.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
}
