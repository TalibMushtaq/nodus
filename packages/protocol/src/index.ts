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
export {
  toProtocolFileId,
  fromProtocolFileId,
  RecipientKindSchema,
  type RecipientKind,
} from "./types.js";

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
  NodeStorageStatsSchema,
  type NodeStorageStats,
  PingPayloadSchema,
  type PingPayload,
  PongPayloadSchema,
  type PongPayload,
  PresenceQueryPayloadSchema,
  type PresenceQueryPayload,
  PresenceResultPayloadSchema,
  type PresenceResultPayload,
  NodeAuthChallengePayloadSchema,
  type NodeAuthChallengePayload,
  NodeAuthResponsePayloadSchema,
  type NodeAuthResponsePayload,
  NodeAuthResultPayloadSchema,
  type NodeAuthResultPayload,
  NodePeerSchema,
  type NodePeer,
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
  NodeShardFetchPayloadSchema,
  type NodeShardFetchPayload,
  ShardFetchRequestPayloadSchema,
  type ShardFetchRequestPayload,
  ShardDataHeaderSchema,
  type ShardDataHeader,
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
  // Design A shard stream framing (Relay ↔ Node binary frames)
  SHARD_FRAME_VERSION,
  SHARD_FRAME_HEADER_BYTES,
  SHARD_FRAME_MAX_REQUEST_ID_BYTES,
  encodeShardFrame,
  decodeShardFrame,
} from "./messages/transfer.js";

// ── Tombstone control messages (WS: Relay ↔ Node) ───────────────────

export {
  TombstoneEntityTypeSchema,
  type TombstoneEntityType,
  TombstoneAckStatusSchema,
  type TombstoneAckStatus,
  TombstoneAckPayloadSchema,
  type TombstoneAckPayload,
  PurgeTombstonePayloadSchema,
  type PurgeTombstonePayload,
  RestoreTombstonePayloadSchema,
  type RestoreTombstonePayload,
} from "./messages/tombstone.js";

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
  CatalogChangedPayloadSchema,
  type CatalogChangedPayload,
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
  FolderRecordSchema,
  type FolderRecord,
  KeyEnvelopeRecordSchema,
  type KeyEnvelopeRecord,
  FolderKeyEnvelopeRecordSchema,
  type FolderKeyEnvelopeRecord,
  TombstoneRecordSchema,
  type TombstoneRecord,
  ShardHashRecordSchema,
  type ShardHashRecord,
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

// ── Phase 11: Pairing (WS: pairing_token_push only) ─────────────────

export {
  PairingRequestPayloadSchema,
  type PairingRequestPayload,
  PairingConfirmPayloadSchema,
  type PairingConfirmPayload,
  PairingRejectPayloadSchema,
  type PairingRejectPayload,
  PairingTokenPushPayloadSchema,
  type PairingTokenPushPayload,
} from "./messages/pairing.js";

// ── Phase 11: Local discovery + auth (HTTP-only contracts) ──────────

export {
  LocalDiscoveryAdvertisementSchema,
  type LocalDiscoveryAdvertisement,
  LocalDiscoveryPingSchema,
  type LocalDiscoveryPing,
  LocalDiscoveryPongSchema,
  type LocalDiscoveryPong,
} from "./messages/local-discovery.js";

export {
  LocalChallengePayloadSchema,
  type LocalChallengePayload,
  LocalChallengeResponsePayloadSchema,
  type LocalChallengeResponsePayload,
  LocalAuthResultPayloadSchema,
  type LocalAuthResultPayload,
} from "./messages/local-auth.js";

export {
  LocalRecoveryChallengeSchema,
  type LocalRecoveryChallenge,
  LocalRecoveryRequestSchema,
  type LocalRecoveryRequest,
  LocalRecoveryResultSchema,
  type LocalRecoveryResult,
  LocalRecoveryFileEnvelopeSchema,
  type LocalRecoveryFileEnvelope,
  LocalRecoveryFolderEnvelopeSchema,
  type LocalRecoveryFolderEnvelope,
  LocalRecoveryEnvelopesSchema,
  type LocalRecoveryEnvelopes,
} from "./messages/local-recovery.js";
export {
  ActivityKindSchema,
  type ActivityKind,
  ActivityOutcomeSchema,
  type ActivityOutcome,
  ActivityRecordSchema,
  type ActivityRecord,
  ActivityListSchema,
  type ActivityList,
} from "./messages/activity.js";

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
  TombstoneRemovedPayloadSchema,
  FolderEventPayloadSchema,
  KeyEnvelopePayloadSchema,
  FolderKeyEnvelopePayloadSchema,
  FileShardManifestPayloadSchema,
  ConflictResolvedPayloadSchema,
  validateEventPayload,
  EventPayloadMap,
} from "./events/event-types.js";
