// Sync-event builders for file metadata mutations (rename / delete), shared by
// web and native.
//
// The event shapes are dictated by the existing Relay + Storage Node
// projections, which have no dedicated rename type:
//  - Rename re-emits `FILE_CREATED`, whose projection is an upsert that updates
//    `encrypted_name`/`parent_folder_id` without touching versions.
//  - Delete emits `TOMBSTONE_CREATED`, because the parsers on both backends
//    read the tombstone shape (`entity_type`/`entity_id`); the `FILE_DELETED`
//    protocol schema is a file_id payload and would project nothing.

import { EventTypes } from "@repo/protocol";
import type { EventPayload } from "@repo/protocol";

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

/** Metadata upsert used for a rename (see module note). */
export function fileUpsertEvent(
  originId: string,
  sequence: number,
  fileId: string,
  metadata: { parentFolderId: string | null; encryptedName: string },
): EventPayload {
  return baseEvent(originId, sequence, EventTypes.FILE_CREATED, {
    file_id: fileId,
    parent_folder_id: metadata.parentFolderId,
    encrypted_name: metadata.encryptedName,
  });
}

/** Tombstone used for a delete (soft delete; GC runs on the retention window). */
export function fileDeletedEvent(originId: string, sequence: number, fileId: string): EventPayload {
  return baseEvent(originId, sequence, EventTypes.TOMBSTONE_CREATED, {
    entity_type: "file",
    entity_id: fileId,
    deleted_at: new Date().toISOString(),
  });
}

/**
 * Resolve a file's conflicted copy (ADR-0003). Both the Relay and every Storage
 * Node mark the file's flagged versions `resolved`; the version data is kept.
 *
 * `keepVersion` (ADR-0003 addendum) records which side the user chose to keep;
 * it never deletes the other branch, so the choice stays reversible.
 */
export function conflictResolvedEvent(
  originId: string,
  sequence: number,
  fileId: string,
  keepVersion?: number,
): EventPayload {
  return baseEvent(originId, sequence, EventTypes.CONFLICT_RESOLVED, {
    file_id: fileId,
    ...(keepVersion !== undefined ? { keep_version: keepVersion } : {}),
  });
}
