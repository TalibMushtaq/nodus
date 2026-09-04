import { z } from "zod";
import { EventIdSchema } from "../types.js";

// ── Event type enum ────────────────────────────────────────────────

/**
 * Canonical event types. This is the authoritative list that all implementations
 * (TS, Rust, Go) must agree on. New types should be appended, never reordered.
 *
 * Each type maps to a payload schema in `EventPayloadSchemas` below.
 */
export const EventTypes = {
  FILE_CREATED: "FILE_CREATED",
  FILE_DELETED: "FILE_DELETED",
  FILE_VERSION_ADDED: "FILE_VERSION_ADDED",
  FILE_MODIFIED: "FILE_MODIFIED",
  DEVICE_REVOKED: "DEVICE_REVOKED",
  TOMBSTONE_CREATED: "TOMBSTONE_CREATED",
  FOLDER_CREATED: "FOLDER_CREATED",
  FOLDER_DELETED: "FOLDER_DELETED",
} as const;

export const EventTypeSchema = z.enum([
  EventTypes.FILE_CREATED,
  EventTypes.FILE_DELETED,
  EventTypes.FILE_VERSION_ADDED,
  EventTypes.FILE_MODIFIED,
  EventTypes.DEVICE_REVOKED,
  EventTypes.TOMBSTONE_CREATED,
  EventTypes.FOLDER_CREATED,
  EventTypes.FOLDER_DELETED,
]);

export type EventType = z.infer<typeof EventTypeSchema>;

// ── Per-type payload schemas ───────────────────────────────────────

/**
 * File metadata carried in file-related events. Fields are intentionally
 * sparse — the full file record lives in the database; the event carries
 * only enough for the receiver to apply the change.
 */
export const FileEventPayloadSchema = z.object({
  file_id: z.string(),
  /** Parent folder ID; null for root-level files */
  parent_folder_id: z.string().nullable().optional(),
  /** Encrypted filename (opaque to the relay, readable only by the account) */
  encrypted_name: z.string().optional(),
  /** BLAKE3 content hash of the latest version, if this event represents a state change */
  content_hash: z.string().optional(),
});

/**
 * Version-specific payload for FILE_VERSION_ADDED events.
 * Carries the shard manifest summary so the receiver knows what to fetch.
 */
export const FileVersionPayloadSchema = FileEventPayloadSchema.extend({
  /** Monotonic version number for this file */
  version_number: z.number().int().min(1),
  /** Parent version number for branch tracking / conflict detection */
  parent_version_id: z.number().int().min(1).nullable().optional(),
  /** Total shard count for this version */
  shard_count: z.number().int().min(1),
  /** Content hash of this specific version */
  version_hash: z.string(),
  /** Conflict status if flagged or resolved */
  conflict_status: z.enum(["none", "flagged", "resolved"]).optional(),
});

/**
 * Device revocation event payload.
 */
export const DeviceRevokedPayloadSchema = z.object({
  device_id: z.string(),
  /** Timestamp of the revocation */
  revoked_at: z.string().datetime(),
});

/**
 * Tombstone event payload (§17, §17a).
 * Tombstones prevent a long-offline device from resurrecting a deleted file
 * when it reconnects. The TTL is controlled by the GC policy (§29a).
 */
export const TombstonePayloadSchema = z.object({
  /** The entity that was deleted — identified by its ID and type */
  entity_type: z.enum(["file", "folder"]),
  entity_id: z.string(),
  /** When the tombstone was created */
  deleted_at: z.string().datetime(),
});

/**
 * Folder event payload.
 */
export const FolderEventPayloadSchema = z.object({
  folder_id: z.string(),
  parent_folder_id: z.string().nullable().optional(),
  encrypted_name: z.string().optional(),
});

// ── Event payload union ────────────────────────────────────────────

/**
 * Zod discriminated-union-style mapping from EventType to its payload schema.
 * Used by the EventPayloadSchema to validate the right shape per event type.
 */
const EventPayloadMap: Record<EventType, z.ZodType> = {
  FILE_CREATED: FileEventPayloadSchema,
  FILE_DELETED: FileEventPayloadSchema,
  FILE_VERSION_ADDED: FileVersionPayloadSchema,
  FILE_MODIFIED: FileVersionPayloadSchema,
  DEVICE_REVOKED: DeviceRevokedPayloadSchema,
  TOMBSTONE_CREATED: TombstonePayloadSchema,
  FOLDER_CREATED: FolderEventPayloadSchema,
  FOLDER_DELETED: FolderEventPayloadSchema,
};

/**
 * A custom Zod type that validates the payload according to its `type` field.
 * Not a native discriminated union because the `type` is on the outer envelope,
 * not directly inside the event object — the payload schema is selected by the
 * event's type at validation time.
 */
export const EventPayloadSchema = z
  .object({
    event_id: EventIdSchema,
    /** ID of the origin (node or device) that created this event */
    origin_id: z.string(),
    /**
     * Monotonically increasing sequence number scoped to the origin.
     * Together with origin_id, this provides total ordering per origin
     * and enables cursor-based sync (§18).
     */
    origin_sequence: z.number().int().min(0),
    type: EventTypeSchema,
    payload: z.record(z.string(), z.unknown()),
    /** ISO 8601 timestamp of when the event was created at the origin */
    timestamp: z.string().datetime(),
  })
  .refine(
    (data) => {
      const schema = EventPayloadMap[data.type];
      if (!schema) return false;
      return schema.safeParse(data.payload).success;
    },
    {
      message: "Event payload does not match the schema for its event type",
    },
  );

export type EventPayload = z.infer<typeof EventPayloadSchema>;

/**
 * Validate a specific event payload against its type's schema.
 * Use this when you need to validate payload shapes independently of the
 * event envelope (e.g. when reconstructing events from a database).
 */
export function validateEventPayload(
  type: EventType,
  payload: unknown,
): { ok: true } | { ok: false; error: string } {
  const schema = EventPayloadMap[type];
  if (!schema) {
    return { ok: false, error: `Unknown event type "${type}"` };
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    return {
      ok: false,
      error: `Invalid payload for event type "${type}": ${result.error.message}`,
    };
  }
  return { ok: true };
}

/**
 * Export the raw per-type schemas for consumers that need direct access
 * (e.g. database serialization layers in Rust/Go that reference the TS
 * definitions as canonical).
 */
export { EventPayloadMap };
