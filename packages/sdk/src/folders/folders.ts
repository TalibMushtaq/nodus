// Folder create / rename / delete (shared by web and native).
//
// A folder is metadata: create and rename emit FOLDER_CREATED (both backends
// upsert the folder row) and delete emits FOLDER_DELETED (a tombstone). Folder
// names are encrypted with a fresh per-folder key, so creation must also
// distribute that key to the account's other devices/nodes as
// FOLDER_KEY_ENVELOPE_ADDED events — otherwise only this device could render
// the name. A rename reuses the existing key.
//
// All side effects are injected so the browser and native clients share one
// implementation of the ordering and failure semantics.

import { encryptName, generateFileEncryptionKey } from "@repo/core";
import { EventTypes } from "@repo/protocol";
import type { BatchAckPayload, EventPayload } from "@repo/protocol";

import {
  collectRecipients,
  folderEnvelopeEvent,
  sealFekForRecipients,
  type RecipientSources,
} from "../envelopes/envelopes.js";

function baseEvent(
  originId: string,
  sequence: number,
  type: EventPayload["type"],
  payload: Record<string, unknown>,
): EventPayload {
  return {
    event_id: crypto.randomUUID() as EventPayload["event_id"],
    origin_id: originId,
    origin_sequence: sequence,
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
}

/** `encryptedName` is folder-key-encrypted (see @repo/core `encryptName`). */
export function folderCreatedEvent(
  originId: string,
  sequence: number,
  folder: { folderId: string; parentFolderId?: string | null; encryptedName?: string | null },
): EventPayload {
  return baseEvent(originId, sequence, EventTypes.FOLDER_CREATED, {
    folder_id: folder.folderId,
    parent_folder_id: folder.parentFolderId ?? null,
    encrypted_name: folder.encryptedName ?? null,
  });
}

export function folderDeletedEvent(originId: string, sequence: number, folderId: string): EventPayload {
  return baseEvent(originId, sequence, EventTypes.FOLDER_DELETED, {
    folder_id: folderId,
  });
}

export interface FolderMutationDeps {
  /**
   * `x25519PublicKey` is the device's published standalone X25519 key (ADR-0008),
   * used to seal this device's own folder-key envelope to the key it opens with;
   * omit it only for legacy callers that still have the Ed25519-derived key.
   */
  device: { deviceId: string; edPublicKey: Uint8Array; x25519PublicKey?: Uint8Array };
  /** Account recovery key (base64) to also seal folder keys to, when enrolled. */
  recoveryPublicKey?: string | null;
  putFolderKey(folderId: string, key: Uint8Array): Promise<void>;
  getFolderKey(folderId: string): Promise<Uint8Array | undefined>;
  /**
   * Resolve this device's key for a folder: its locally stored copy, else the
   * key from its own sealed envelope. Injected so each platform uses its own
   * encryption key (web X25519 handle, mobile keychain).
   */
  resolveFolderKey(folderId: string): Promise<Uint8Array | null>;
  allocateSequence(originId: string): Promise<number>;
  sendEventBatch(events: EventPayload[]): Promise<BatchAckPayload | void>;
  /** Device/node catalogue for folder-key envelope distribution. */
  recipientSources: RecipientSources;
}

export interface FolderMutations {
  create(name: string, parentFolderId: string | null): Promise<string>;
  rename(folderId: string, parentFolderId: string | null, newName: string): Promise<void>;
  remove(folderId: string): Promise<void>;
  /** This device's key for a folder (local copy, else its sealed envelope). */
  loadFolderKey(folderId: string): Promise<Uint8Array | null>;
}

export function createFolderMutations(deps: FolderMutationDeps): FolderMutations {
  const { device } = deps;

  async function loadFolderKey(folderId: string): Promise<Uint8Array | null> {
    const local = await deps.getFolderKey(folderId);
    if (local) return local;
    try {
      return await deps.resolveFolderKey(folderId);
    } catch {
      return null;
    }
  }

  async function create(name: string, parentFolderId: string | null): Promise<string> {
    const folderId = crypto.randomUUID();
    const key = generateFileEncryptionKey();

    // Durability gate: persist the key before emitting any event that references
    // the folder, so a reload cannot leave an unreadable name.
    await deps.putFolderKey(folderId, key);
    const encryptedName = encryptName(name, key);

    const sequence = await deps.allocateSequence(device.deviceId);
    const ack = await deps.sendEventBatch([
      folderCreatedEvent(device.deviceId, sequence, { folderId, parentFolderId, encryptedName }),
    ]);
    if (ack && ack.ok === false) {
      throw new Error(ack.reason ?? "folder create rejected");
    }

    // Distribute the folder key after the row exists (the Relay's foreign-folder
    // guard and the FK both require it). A failure here must not fail creation:
    // the folder exists and is locally readable, and another device simply sees
    // an id until distribution succeeds.
    try {
      const recipients = await collectRecipients(
        {
          deviceId: device.deviceId,
          edPublicKey: device.edPublicKey,
          x25519PublicKey: device.x25519PublicKey,
          recoveryPublicKey: deps.recoveryPublicKey ?? null,
        },
        deps.recipientSources,
      );
      const sealed = sealFekForRecipients(key, recipients);
      const events: EventPayload[] = [];
      for (const envelope of sealed) {
        const envSequence = await deps.allocateSequence(device.deviceId);
        events.push(folderEnvelopeEvent(device.deviceId, envSequence, folderId, envelope));
      }
      const envAck = await deps.sendEventBatch(events);
      if (envAck && envAck.ok === false) {
        throw new Error(envAck.reason ?? "folder key envelope batch rejected");
      }
    } catch (err) {
      // Best-effort: the folder remains usable on this device.
      console.warn("folder key distribution failed; name will not sync to other devices", err);
    }

    return folderId;
  }

  async function remove(folderId: string): Promise<void> {
    const sequence = await deps.allocateSequence(device.deviceId);
    const ack = await deps.sendEventBatch([folderDeletedEvent(device.deviceId, sequence, folderId)]);
    if (ack && ack.ok === false) {
      throw new Error(ack.reason ?? "folder delete rejected");
    }
  }

  async function rename(
    folderId: string,
    parentFolderId: string | null,
    newName: string,
  ): Promise<void> {
    const key = await loadFolderKey(folderId);
    if (!key) {
      throw new Error("This device has no key for that folder.");
    }
    // A rename is a FOLDER_CREATED upsert with a re-encrypted name; the folder
    // key (and therefore every existing name ciphertext) is unchanged.
    const encryptedName = encryptName(newName, key);
    const sequence = await deps.allocateSequence(device.deviceId);
    const ack = await deps.sendEventBatch([
      folderCreatedEvent(device.deviceId, sequence, { folderId, parentFolderId, encryptedName }),
    ]);
    if (ack && ack.ok === false) {
      throw new Error(ack.reason ?? "folder rename rejected");
    }
  }

  return { create, rename, remove, loadFolderKey };
}
