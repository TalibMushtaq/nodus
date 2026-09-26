// Envelope backfill for newly registered devices (ADR-0001/0002 gap).
//
// Uploads seal a file's FEK to every device that is ACTIVE at upload time, so a
// device that registers *later* receives no envelope and can only read the file
// by recovering with the account phrase. This module closes that gap from any
// device that still holds the keys: it re-seals every key it can open to each
// ACTIVE device whose envelope coverage is short of the catalog. Revoked devices
// are never targeted, so revocation still cuts access off.

import type { EventPayload } from "@repo/protocol";
import {
  resealKeysToRecipient,
  type EnvelopeRecipient,
  type EnvelopeSummary,
} from "@repo/sdk";

import type { CatalogEntry, RelayFolder } from "./catalog";

/** The device fields the backfill needs from the Relay catalogue. */
export interface BackfillDevice {
  device_id: string;
  status: string;
}

export interface EnvelopeBackfillDeps {
  /** This (key-holding) device's id; never targeted. */
  deviceId: string;
  catalog: CatalogEntry[];
  folders: RelayFolder[];
  devices: BackfillDevice[];
  /** Per-recipient coverage from `GET /envelopes/summary`. */
  summary: EnvelopeSummary[];
  /**
   * Recipients built by `collectRecipients`, so the sealed key material matches
   * the upload path exactly (published X25519 key when present, derived fallback
   * otherwise).
   */
  recipients: EnvelopeRecipient[];
  /** This device's key for a file (local or its own envelope), or null. */
  resolveFileKey(fileId: string): Promise<Uint8Array | null>;
  /** This device's key for a folder (local or its own envelope), or null. */
  resolveFolderKey(folderId: string): Promise<Uint8Array | null>;
  allocateSequence(originId: string): Promise<number>;
  sendEventBatch(events: EventPayload[]): Promise<{ ok?: boolean; reason?: string } | void>;
}

export interface EnvelopeBackfillResult {
  /** Devices that received at least one re-sealed key. */
  devices: number;
  files: number;
  folders: number;
}

/**
 * Re-seal this device's openable file/folder keys to every active device whose
 * coverage is short of the catalog. Returns what was sealed; best-effort callers
 * swallow failures.
 *
 * Idempotent by coverage: once a device holds an envelope for every file and
 * folder it is skipped, so a completed backfill does not re-emit events on the
 * next session.
 */
export async function backfillMissingEnvelopes(
  deps: EnvelopeBackfillDeps,
): Promise<EnvelopeBackfillResult> {
  const result: EnvelopeBackfillResult = { devices: 0, files: 0, folders: 0 };
  // Nothing to distribute yet (an empty account, or a catalog that failed to
  // load): treating "no files" as complete coverage would be wrong, so bail.
  if (deps.catalog.length === 0 && deps.folders.length === 0) return result;

  const coverage = new Map<string, EnvelopeSummary>();
  for (const row of deps.summary) coverage.set(row.recipient_id, row);

  for (const device of deps.devices) {
    if (device.status !== "ACTIVE" || device.device_id === deps.deviceId) continue;
    const recipient = deps.recipients.find(
      (candidate) =>
        candidate.recipientId === device.device_id && candidate.recipientKind === "device",
    );
    // `collectRecipients` already filters to ACTIVE devices with a usable key; a
    // missing recipient means there is nothing to seal to yet.
    if (!recipient) continue;

    const held = coverage.get(device.device_id);
    if (
      held &&
      held.file_count >= deps.catalog.length &&
      held.folder_count >= deps.folders.length
    ) {
      continue;
    }

    const sealed = await resealKeysToRecipient(
      {
        device: { deviceId: deps.deviceId },
        listCatalog: async () => deps.catalog,
        listFolders: async () => deps.folders,
        resolveFileKey: deps.resolveFileKey,
        resolveFolderKey: deps.resolveFolderKey,
        allocateSequence: deps.allocateSequence,
        sendEventBatch: deps.sendEventBatch,
      },
      recipient,
    );
    result.devices += 1;
    result.files += sealed.files;
    result.folders += sealed.folders;
  }

  return result;
}
