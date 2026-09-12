// Builders for FOLDER_CREATED / FOLDER_DELETED sync events (Phase 14 F1).
// They mirror the uploader's event shape; the caller supplies the
// `origin_sequence` (allocated atomically via nextOriginSequence) and sends the
// batch over the shared WebSocket.

import { EventTypes } from "@repo/protocol";
import type { EventPayload } from "@repo/protocol";

function baseEvent(originId: string, sequence: number, type: EventPayload["type"], payload: Record<string, unknown>): EventPayload {
  return {
    event_id: crypto.randomUUID() as EventPayload["event_id"],
    origin_id: originId,
    origin_sequence: sequence,
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
}

/** `encryptedName` is FEK-encrypted (see @repo/core `encryptName`). */
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
