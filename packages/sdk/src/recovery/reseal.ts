// Re-seal every file/folder key this device can open to the account recovery
// identity, shared by web and native.
//
// Used when recovery is first enrolled and after the recovery key is
// regenerated. Only keys this device holds (locally, or via its own sealed
// envelope) can be re-sealed, so the result reports how many were skipped and
// the UI can be honest that coverage may be partial.

import type { EventPayload } from "@repo/protocol";

import type { CatalogEntry, RelayFolder } from "../catalog/catalog.js";
import {
  decodeRecipientPublicKey,
  envelopeEvent,
  folderEnvelopeEvent,
  sealFekForRecipients,
} from "../envelopes/envelopes.js";

// Envelope batches are chunked so a large account does not exceed the Relay's
// message size in one event_batch frame.
const RESEAL_BATCH_SIZE = 200;

export interface ResealDeps {
  device: { deviceId: string; edPrivateSeed: Uint8Array };
  listCatalog(): Promise<CatalogEntry[]>;
  listFolders(): Promise<RelayFolder[]>;
  /** This device's FEK for a file (local or its own envelope), or null. */
  resolveFileKey(fileId: string): Promise<Uint8Array | null>;
  /** This device's key for a folder (local or its own envelope), or null. */
  resolveFolderKey(folderId: string): Promise<Uint8Array | null>;
  allocateSequence(originId: string): Promise<number>;
  sendEventBatch(events: EventPayload[]): Promise<{ ok?: boolean; reason?: string } | void>;
  /** Envelope events per batch; the default keeps frames within Relay limits. */
  batchSize?: number;
}

export interface ResealResult {
  files: number;
  folders: number;
  /** Keys this device could not open, so could not re-seal to recovery. */
  skipped: number;
}

export async function resealRecoveryKeys(
  deps: ResealDeps,
  recoveryPublicKey: string,
): Promise<ResealResult> {
  const recipient = {
    recipientId: recoveryPublicKey,
    recipientKind: "recovery" as const,
    edPublicKey: decodeRecipientPublicKey(recoveryPublicKey, "recovery"),
  };

  const [catalog, folders] = await Promise.all([deps.listCatalog(), deps.listFolders()]);
  const events: EventPayload[] = [];
  let files = 0;
  let foldersSealed = 0;
  let skipped = 0;

  for (const entry of catalog) {
    const fek = await deps.resolveFileKey(entry.file_id);
    if (!fek) {
      skipped += 1;
      continue;
    }
    const sealed = sealFekForRecipients(fek, [recipient])[0]!;
    const sequence = await deps.allocateSequence(deps.device.deviceId);
    events.push(envelopeEvent(deps.device.deviceId, sequence, entry.file_id, sealed));
    files += 1;
  }

  for (const folder of folders) {
    const key = await deps.resolveFolderKey(folder.folder_id);
    if (!key) {
      skipped += 1;
      continue;
    }
    const sealed = sealFekForRecipients(key, [recipient])[0]!;
    const sequence = await deps.allocateSequence(deps.device.deviceId);
    events.push(folderEnvelopeEvent(deps.device.deviceId, sequence, folder.folder_id, sealed));
    foldersSealed += 1;
  }

  const batchSize = deps.batchSize ?? RESEAL_BATCH_SIZE;
  for (let index = 0; index < events.length; index += batchSize) {
    const ack = await deps.sendEventBatch(events.slice(index, index + batchSize));
    if (ack && ack.ok === false) {
      throw new Error(ack.reason ?? "recovery re-seal batch rejected");
    }
  }

  return { files, folders: foldersSealed, skipped };
}
