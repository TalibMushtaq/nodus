import { z } from "zod";
import { CURRENT_SCHEMA_VERSION, SchemaVersionSchema, isCompatible } from "./version.js";
import { ErrorCodes, ProtocolError } from "./errors.js";
import { MessageId } from "./types.js";
import {
  RegisterPayloadSchema,
  HeartbeatPayloadSchema,
} from "./messages/control.js";
import {
  WebRTCOfferPayloadSchema,
  WebRTCAnswerPayloadSchema,
  WebRTCIceCandidatePayloadSchema,
} from "./messages/webrtc.js";
import {
  ShardUploadPayloadSchema,
  ShardAckPayloadSchema,
  PendingNotifyPayloadSchema,
  ShardFetchPayloadSchema,
  ShardDeletePayloadSchema,
} from "./messages/transfer.js";
import {
  SyncHelloPayloadSchema,
  SyncStatusPayloadSchema,
  EventBatchPayloadSchema,
  ReconcilePayloadSchema,
} from "./messages/sync.js";
import {
  SnapshotBeginPayloadSchema,
  SnapshotChunkPayloadSchema,
  SnapshotEndPayloadSchema,
} from "./messages/snapshot.js";
import { ErrorPayloadSchema } from "./errors.js";

// ── Message type literals ──────────────────────────────────────────

/**
 * Exhaustive union of all known message type literals.
 * New message types must be added here AND to `MessagePayloadSchemas` in
 * `parseMessage` so that dispatch works.
 */
export const MessageTypes = {
  REGISTER: "register",
  HEARTBEAT: "heartbeat",
  WEBRTC_OFFER: "webrtc_offer",
  WEBRTC_ANSWER: "webrtc_answer",
  WEBRTC_ICE_CANDIDATE: "webrtc_ice_candidate",
  SHARD_UPLOAD: "shard_upload",
  SHARD_ACK: "shard_ack",
  PENDING_NOTIFY: "pending_notify",
  SHARD_FETCH: "shard_fetch",
  SHARD_DELETE: "shard_delete",
  SYNC_HELLO: "sync_hello",
  SYNC_STATUS: "sync_status",
  EVENT_BATCH: "event_batch",
  RECONCILE: "reconcile",
  SNAPSHOT_BEGIN: "snapshot_begin",
  SNAPSHOT_CHUNK: "snapshot_chunk",
  SNAPSHOT_END: "snapshot_end",
  ERROR: "error",
} as const;

export type MessageTypeValue = (typeof MessageTypes)[keyof typeof MessageTypes];

// ── Base envelope ──────────────────────────────────────────────────

/**
 * Every Nodus message is wrapped in this envelope before its type-specific
 * payload. `schema_version` is per-message (not negotiated once at connection
 * time) so that messages are self-describing and debuggable.
 */
export const BaseEnvelopeSchema = z.object({
  type: z.string(),
  schema_version: SchemaVersionSchema,
  message_id: MessageId,
  timestamp: z.string().datetime().optional(),
});

export type BaseEnvelope = z.infer<typeof BaseEnvelopeSchema>;

// ── Parse result type ──────────────────────────────────────────────

/**
 * The result of `parseMessage`. Discriminated union so callers can switch on
 * `ok` without catching exceptions. A structured validation error is returned
 * (never thrown) when the message is malformed or unknown.
 */
export type ParseResult =
  | { ok: true; message: BaseEnvelope & { payload: unknown } }
  | { ok: false; error: ProtocolError };

// ── Message payload schema registry ────────────────────────────────

/**
 * Mapping from message type string to its payload schema. This is the single
 * dispatch table for `parseMessage`. Kept here (importing all message modules)
 * so that each message schema stays co-located with its type in its own file.
 */
export const MessagePayloadSchemas: Record<string, z.ZodType> = {
  [MessageTypes.REGISTER]: RegisterPayloadSchema,
  [MessageTypes.HEARTBEAT]: HeartbeatPayloadSchema,
  [MessageTypes.WEBRTC_OFFER]: WebRTCOfferPayloadSchema,
  [MessageTypes.WEBRTC_ANSWER]: WebRTCAnswerPayloadSchema,
  [MessageTypes.WEBRTC_ICE_CANDIDATE]: WebRTCIceCandidatePayloadSchema,
  [MessageTypes.SHARD_UPLOAD]: ShardUploadPayloadSchema,
  [MessageTypes.SHARD_ACK]: ShardAckPayloadSchema,
  [MessageTypes.PENDING_NOTIFY]: PendingNotifyPayloadSchema,
  [MessageTypes.SHARD_FETCH]: ShardFetchPayloadSchema,
  [MessageTypes.SHARD_DELETE]: ShardDeletePayloadSchema,
  [MessageTypes.SYNC_HELLO]: SyncHelloPayloadSchema,
  [MessageTypes.SYNC_STATUS]: SyncStatusPayloadSchema,
  [MessageTypes.EVENT_BATCH]: EventBatchPayloadSchema,
  [MessageTypes.RECONCILE]: ReconcilePayloadSchema,
  [MessageTypes.SNAPSHOT_BEGIN]: SnapshotBeginPayloadSchema,
  [MessageTypes.SNAPSHOT_CHUNK]: SnapshotChunkPayloadSchema,
  [MessageTypes.SNAPSHOT_END]: SnapshotEndPayloadSchema,
  [MessageTypes.ERROR]: ErrorPayloadSchema,
};

// ── parseMessage ───────────────────────────────────────────────────

/**
 * Validate a raw unknown value as a Nodus protocol message.
 *
 * 1. Validates the base envelope (type, schema_version, message_id).
 * 2. Checks schema version compatibility (rejects mismatched major version).
 * 3. Dispatches to the type-specific payload schema.
 * 4. Returns the validated, fully-typed message or a structured error.
 *
 * This never throws — all failures are captured in the `ParseResult`.
 */
export function parseMessage(raw: unknown): ParseResult {
  // Step 1: envelope validation
  const envelopeResult = BaseEnvelopeSchema.safeParse(raw);
  if (!envelopeResult.success) {
    return {
      ok: false,
      error: new ProtocolError(
        ErrorCodes.VALIDATION_ERROR,
        `Envelope validation failed: ${envelopeResult.error.message}`,
      ),
    };
  }

  const envelope = envelopeResult.data;

  // Step 2: version compatibility
  if (!isCompatible(envelope.schema_version)) {
    return {
      ok: false,
      error: new ProtocolError(
        ErrorCodes.INCOMPATIBLE_VERSION,
        `Incompatible schema version "${envelope.schema_version}"; expected major version ${CURRENT_SCHEMA_VERSION.split(".")[0]}`,
      ),
    };
  }

  // Step 3: payload dispatch
  const payloadSchema = MessagePayloadSchemas[envelope.type];
  if (!payloadSchema) {
    return {
      ok: false,
      error: new ProtocolError(
        ErrorCodes.UNKNOWN_MESSAGE_TYPE,
        `Unknown message type "${envelope.type}"`,
        { correlationId: envelope.message_id },
      ),
    };
  }

  const payloadResult = payloadSchema.safeParse(
    (raw as Record<string, unknown>)["payload"],
  );
  if (!payloadResult.success) {
    return {
      ok: false,
      error: new ProtocolError(
        ErrorCodes.VALIDATION_ERROR,
        `Payload validation failed for type "${envelope.type}": ${payloadResult.error.message}`,
        { correlationId: envelope.message_id },
      ),
    };
  }

  // Step 4: return validated result
  return {
    ok: true,
    message: { ...envelope, payload: payloadResult.data },
  };
}

// ── Re-export branded types for convenience ────────────────────────
// Branded names that are also zod schema values (AccountId, DeviceId, ...) get
// a bare re-export which carries both value and type. EventId has only a type
// alias (its schema is named EventIdSchema), so it must be re-exported with
// `export type` to satisfy isolatedModules.

export { AccountId, DeviceId, NodeId, MessageId, ProtocolFileId, EventIdSchema, TransferId, SnapshotId } from "./types.js";
export type { EventId } from "./types.js";
