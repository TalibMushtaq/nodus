// ── Protocol Package — Public API ───────────────────────────────────
//
// This is the canonical entry point for @repo/protocol. All public exports
// flow through here so consumers import from "packages/protocol" directly.
// Internal modules remain importable via deep paths for tree-shaking, but
// index.ts is the recommended import target.

// ── Version & schema compatibility ─────────────────────────────────

export {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SNAPSHOT_CHUNK_SIZE,
  SchemaVersionSchema,
  type SchemaVersion,
  parseVersion,
  isCompatible,
} from "./version.js";

// ── Envelope & message dispatch ────────────────────────────────────

export {
  // Branded identity types (values are zod schemas; types ride along)
  AccountId,
  DeviceId,
  NodeId,
  MessageId,
  ProtocolFileId,
  EventIdSchema,
  TransferId,
  SnapshotId,
  // Message types & envelope
  MessageTypes,
  type MessageTypeValue,
  BaseEnvelopeSchema,
  type BaseEnvelope,
  parseMessage,
  type ParseResult,
} from "./envelope.js";
export type { EventId } from "./envelope.js";
export { toProtocolFileId, fromProtocolFileId } from "./types.js";

// ── Error types ────────────────────────────────────────────────────

export {
  ErrorCodes,
  ErrorCodeSchema,
  type ErrorCode,
  ErrorPayloadSchema,
  type ErrorPayload,
  ErrorMessageSchema,
  type ErrorMessage,
  ProtocolError,
} from "./errors.js";

// ── Control messages ───────────────────────────────────────────────

export {
  CapabilitySchema,
  type Capability,
  RegisterPayloadSchema,
  type RegisterPayload,
  HeartbeatPayloadSchema,
  type HeartbeatPayload,
  NodeAuthChallengePayloadSchema,
  type NodeAuthChallengePayload,
  NodeAuthResponsePayloadSchema,
  type NodeAuthResponsePayload,
  NodeAuthResultPayloadSchema,
  type NodeAuthResultPayload,
} from "./messages/control.js";

// ── WebRTC signaling messages ──────────────────────────────────────

export {
  PeerIdSchema,
  type PeerId,
  WebRTCOfferPayloadSchema,
  type WebRTCOfferPayload,
  WebRTCAnswerPayloadSchema,
  type WebRTCAnswerPayload,
  WebRTCIceCandidatePayloadSchema,
  type WebRTCIceCandidatePayload,
} from "./messages/webrtc.js";

// ── Transfer messages ──────────────────────────────────────────────

export {
  ShardUploadPayloadSchema,
  type ShardUploadPayload,
  ShardAckStatusSchema,
  type ShardAckStatus,
  ShardAckPayloadSchema,
  type ShardAckPayload,
  PendingNotifyPayloadSchema,
  type PendingNotifyPayload,
  ShardFetchPayloadSchema,
  type ShardFetchPayload,
  ShardDeletePayloadSchema,
  type ShardDeletePayload,
} from "./messages/transfer.js";

// ── Sync messages ──────────────────────────────────────────────────

export {
  SyncCursorSchema,
  type SyncCursor,
  SyncHelloPayloadSchema,
  type SyncHelloPayload,
  SyncCursorWithCountSchema,
  SyncStatusPayloadSchema,
  type SyncStatusPayload,
  EventBatchPayloadSchema,
  type EventBatchPayload,
  BatchAckPayloadSchema,
  type BatchAckPayload,
  ReconcilePayloadSchema,
  type ReconcilePayload,
} from "./messages/sync.js";

// ── Snapshot messages ──────────────────────────────────────────────

export {
  SNAPSHOT_CHUNK_MAX_RECORDS,
  SnapshotRecordTypeSchema,
  type SnapshotRecordType,
  FileVersionRecordSchema,
  type FileVersionRecord,
  TombstoneRecordSchema,
  type TombstoneRecord,
  SnapshotBeginPayloadSchema,
  type SnapshotBeginPayload,
  SnapshotChunkPayloadSchema,
  type SnapshotChunkPayload,
  SnapshotEndPayloadSchema,
  type SnapshotEndPayload,
} from "./messages/snapshot.js";

// ── Rebuild messages ───────────────────────────────────────────────

export {
  RebuildRequiredPayloadSchema,
  type RebuildRequiredPayload,
} from "./messages/rebuild.js";

// ── Event types ────────────────────────────────────────────────────

export {
  EventTypes,
  EventTypeSchema,
  type EventType,
  EventPayloadSchema,
  type EventPayload,
  FileEventPayloadSchema,
  FileVersionPayloadSchema,
  DeviceRevokedPayloadSchema,
  TombstonePayloadSchema,
  FolderEventPayloadSchema,
  validateEventPayload,
  EventPayloadMap,
} from "./events/event-types.js";
