import { z } from "zod";
import { EventIdSchema, RecipientKindSchema } from "../types.js";

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
  TOMBSTONE_REMOVED: "TOMBSTONE_REMOVED",
  FOLDER_CREATED: "FOLDER_CREATED",
  FOLDER_DELETED: "FOLDER_DELETED",
  KEY_ENVELOPE_ADDED: "KEY_ENVELOPE_ADDED",
  FOLDER_KEY_ENVELOPE_ADDED: "FOLDER_KEY_ENVELOPE_ADDED",
  FILE_SHARD_MANIFEST: "FILE_SHARD_MANIFEST",
  CONFLICT_RESOLVED: "CONFLICT_RESOLVED",
} as const;

export const EventTypeSchema = z.enum([
  EventTypes.FILE_CREATED,
  EventTypes.FILE_DELETED,
  EventTypes.FILE_VERSION_ADDED,
  EventTypes.FILE_MODIFIED,
  EventTypes.DEVICE_REVOKED,
  EventTypes.TOMBSTONE_CREATED,
  EventTypes.TOMBSTONE_REMOVED,
  EventTypes.FOLDER_CREATED,
  EventTypes.FOLDER_DELETED,
  EventTypes.KEY_ENVELOPE_ADDED,
  EventTypes.FOLDER_KEY_ENVELOPE_ADDED,
  EventTypes.FILE_SHARD_MANIFEST,
  EventTypes.CONFLICT_RESOLVED,
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
 * Removing a tombstone (restore) — device-emitted. The Relay and Storage Node
 * delete the matching tombstone row so the entity becomes live again.
 */
export const TombstoneRemovedPayloadSchema = z.object({
  entity_type: z.enum(["file", "folder"]),
  entity_id: z.string(),
});

/**
 * Folder event payload.
 */
export const FolderEventPayloadSchema = z.object({
  folder_id: z.string(),
  parent_folder_id: z.string().nullable().optional(),
  encrypted_name: z.string().optional(),
});

/**
 * Key envelope event payload (§25, Phase 14 F2). A device that holds a file's
 * FEK seals it for another recipient and publishes the opaque envelope. The
 * Relay stores it without ever seeing the FEK or the file key material.
 *
 * `encrypted_key` is a self-describing string produced by the client (JSON
 * envelope fields, base64) so the format can evolve without a schema change.
 */
export const KeyEnvelopePayloadSchema = z.object({
  file_id: z.string(),
  /** device_id or node_id the FEK is sealed for. */
  recipient_id: z.string(),
  recipient_kind: RecipientKindSchema,
  encrypted_key: z.string(),
});

/**
 * Folder key envelope event payload. Folder names are encrypted with a per-folder
 * key, exactly like file names are encrypted with the file's FEK; that key must
 * reach the account's other devices or they cannot render the folder name. This
 * is the folder analogue of `KEY_ENVELOPE_ADDED` (same envelope primitive, keyed
 * by `folder_id` instead of `file_id`).
 */
export const FolderKeyEnvelopePayloadSchema = z.object({
  folder_id: z.string(),
  recipient_id: z.string(),
  recipient_kind: RecipientKindSchema,
  encrypted_key: z.string(),
});

/**
 * Per-shard integrity manifest (audit #22). The uploading device, which alone
 * holds the FEK and encrypted the shards, asserts the BLAKE3 hash of every
 * uploaded shard so a Storage Node can reject bytes a compromised Relay tries
 * to plant for a shard it is first to deliver.
 *
 * `shard_hashes[i]` is the BLAKE3 hex of the packed `nonce||ciphertext` for
 * shard index `i` (the same value used as the shard's content address).
 *
 * `signature` is the origin device's Ed25519 signature over
 * `"nodus-shard-manifest:v1:{file_id}:{version_number}:{blake3(shard_hashes.join(','))}"`.
 * The Node verifies it against the paired device key so the Relay cannot forge
 * a manifest that matches bytes it substituted.
 */
export const FileShardManifestPayloadSchema = z.object({
  file_id: z.string(),
  version_number: z.number().int().min(1),
  shard_hashes: z.array(z.string()).min(1),
  signature: z.string(),
});

/**
 * Conflict resolution (ADR-0003). The user resolves a file's conflicted copy
 * from the inbox; the Relay and every Storage Node mark that file's flagged
 * versions `resolved` so the conflict leaves the inbox on all clients. The
 * version data itself is retained (resolution is an acknowledgement, not a
 * deletion), so a user can still recover either side.
 */
export const ConflictResolvedPayloadSchema = z.object({
  file_id: z.string(),
  /**
   * ADR-0003 addendum: the version the user chose to keep. Optional and
   * additive — an absent value means "no explicit choice", leaving the
   * newest version as the file's current one. Recording the choice never
   * removes version rows or shards.
   */
  keep_version: z.number().int().positive().optional(),
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
  TOMBSTONE_REMOVED: TombstoneRemovedPayloadSchema,
  FOLDER_CREATED: FolderEventPayloadSchema,
  FOLDER_DELETED: FolderEventPayloadSchema,
  KEY_ENVELOPE_ADDED: KeyEnvelopePayloadSchema,
  FOLDER_KEY_ENVELOPE_ADDED: FolderKeyEnvelopePayloadSchema,
  FILE_SHARD_MANIFEST: FileShardManifestPayloadSchema,
  CONFLICT_RESOLVED: ConflictResolvedPayloadSchema,
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
