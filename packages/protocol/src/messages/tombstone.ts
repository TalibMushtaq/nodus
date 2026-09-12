import { z } from "zod";

// Tombstone (soft-delete) control messages.
//
// These mirror the `shard_ack` pattern: they travel over the Relay↔Node
// WebSocket, not the device sync-event stream. The Relay owns the account-scoped
// tombstone and asks nodes to purge; nodes acknowledge back so the UI can show
// per-node delete progress.

/** Deleted entity kind. Mirrors the tombstone payload's entity_type. */
export const TombstoneEntityTypeSchema = z.enum(["file", "folder"]);
export type TombstoneEntityType = z.infer<typeof TombstoneEntityTypeSchema>;

/** Node progress: soft-deleted (thrown away) vs permanently purged. */
export const TombstoneAckStatusSchema = z.enum(["deleted", "purged"]);
export type TombstoneAckStatus = z.infer<typeof TombstoneAckStatusSchema>;

/**
 * Node → Relay. Sent when this node has applied a tombstone (`deleted`) or
 * finished permanently removing the entity's data (`purged`). The node id is
 * taken from the authenticated connection, never trusted from the payload.
 */
export const TombstoneAckPayloadSchema = z.object({
  entity_type: TombstoneEntityTypeSchema,
  entity_id: z.string().min(1),
  status: TombstoneAckStatusSchema,
});

export type TombstoneAckPayload = z.infer<typeof TombstoneAckPayloadSchema>;

/**
 * Relay → Node. Ask the node to permanently remove a tombstoned entity's
 * versions/shards/objects. The node replies with a `tombstone_ack` of
 * status `purged`.
 */
export const PurgeTombstonePayloadSchema = z.object({
  entity_type: TombstoneEntityTypeSchema,
  entity_id: z.string().min(1),
});

export type PurgeTombstonePayload = z.infer<typeof PurgeTombstonePayloadSchema>;

/**
 * Relay → Node. Undo a tombstone (restore): the node drops its tombstone row so
 * the retained data does not get purged at the original retention deadline.
 */
export const RestoreTombstonePayloadSchema = z.object({
  entity_type: TombstoneEntityTypeSchema,
  entity_id: z.string().min(1),
});

export type RestoreTombstonePayload = z.infer<typeof RestoreTombstonePayloadSchema>;
