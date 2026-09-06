import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RegisterPayloadSchema,
  HeartbeatPayloadSchema,
  NodeAuthChallengePayloadSchema,
  NodeAuthResponsePayloadSchema,
  NodeAuthResultPayloadSchema,
  WebRTCOfferPayloadSchema,
  WebRTCAnswerPayloadSchema,
  WebRTCIceCandidatePayloadSchema,
  ShardUploadPayloadSchema,
  ShardAckPayloadSchema,
  PendingNotifyPayloadSchema,
  ShardFetchPayloadSchema,
  ShardDeletePayloadSchema,
  SyncHelloPayloadSchema,
  SyncStatusPayloadSchema,
  EventBatchPayloadSchema,
  BatchAckPayloadSchema,
  ReconcilePayloadSchema,
  SnapshotBeginPayloadSchema,
  SnapshotChunkPayloadSchema,
  SnapshotEndPayloadSchema,
  RebuildRequiredPayloadSchema,
  PairingTokenPushPayloadSchema,
  PairingRequestPayloadSchema,
  PairingConfirmPayloadSchema,
  PairingRejectPayloadSchema,
  LocalDiscoveryAdvertisementSchema,
  LocalDiscoveryPingSchema,
  LocalDiscoveryPongSchema,
  LocalChallengePayloadSchema,
  LocalChallengeResponsePayloadSchema,
  LocalAuthResultPayloadSchema,
  ErrorPayloadSchema,
  EventPayloadSchema,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SNAPSHOT_CHUNK_SIZE,
} from "./index.js";

/**
 * Emits JSON Schema documents for every wire message payload plus the event
 * envelope. Rust (`serde`/json-schema) and Go (`encoding/json`) implementations
 * reference these generated artifacts as the canonical wire contract; the TS
 * zod schemas are the source of truth and generation is deterministic.
 *
 * Run with: `pnpm generate:schemas` from packages/protocol. Output is written
 * to `schemas/*.schema.json` relative to the package root.
 */
type SchemaEntry = { name: string; schema: object };

const entries: SchemaEntry[] = [
  { name: "register", schema: RegisterPayloadSchema.toJSONSchema() },
  { name: "heartbeat", schema: HeartbeatPayloadSchema.toJSONSchema() },
  { name: "node_auth_challenge", schema: NodeAuthChallengePayloadSchema.toJSONSchema() },
  { name: "node_auth_response", schema: NodeAuthResponsePayloadSchema.toJSONSchema() },
  { name: "node_auth_result", schema: NodeAuthResultPayloadSchema.toJSONSchema() },
  { name: "webrtc_offer", schema: WebRTCOfferPayloadSchema.toJSONSchema() },
  { name: "webrtc_answer", schema: WebRTCAnswerPayloadSchema.toJSONSchema() },
  { name: "webrtc_ice_candidate", schema: WebRTCIceCandidatePayloadSchema.toJSONSchema() },
  { name: "shard_upload", schema: ShardUploadPayloadSchema.toJSONSchema() },
  { name: "shard_ack", schema: ShardAckPayloadSchema.toJSONSchema() },
  { name: "pending_notify", schema: PendingNotifyPayloadSchema.toJSONSchema() },
  { name: "shard_fetch", schema: ShardFetchPayloadSchema.toJSONSchema() },
  { name: "shard_delete", schema: ShardDeletePayloadSchema.toJSONSchema() },
  { name: "sync_hello", schema: SyncHelloPayloadSchema.toJSONSchema() },
  { name: "sync_status", schema: SyncStatusPayloadSchema.toJSONSchema() },
  { name: "event_batch", schema: EventBatchPayloadSchema.toJSONSchema() },
  { name: "batch_ack", schema: BatchAckPayloadSchema.toJSONSchema() },
  { name: "reconcile", schema: ReconcilePayloadSchema.toJSONSchema() },
  { name: "snapshot_begin", schema: SnapshotBeginPayloadSchema.toJSONSchema() },
  { name: "snapshot_chunk", schema: SnapshotChunkPayloadSchema.toJSONSchema() },
  { name: "snapshot_end", schema: SnapshotEndPayloadSchema.toJSONSchema() },
  { name: "rebuild_required", schema: RebuildRequiredPayloadSchema.toJSONSchema() },
  // Phase 11 — pairing_token_push is a WS message; the other pairing/local
  // payloads are the Storage Node's local-HTTP contract (device ↔ node) and
  // are emitted as reference schemas for Rust/Go mirroring even though they
  // never appear in the WS envelope dispatch.
  { name: "pairing_token_push", schema: PairingTokenPushPayloadSchema.toJSONSchema() },
  { name: "pairing_request", schema: PairingRequestPayloadSchema.toJSONSchema() },
  { name: "pairing_confirm", schema: PairingConfirmPayloadSchema.toJSONSchema() },
  { name: "pairing_reject", schema: PairingRejectPayloadSchema.toJSONSchema() },
  { name: "local_discovery_advertisement", schema: LocalDiscoveryAdvertisementSchema.toJSONSchema() },
  { name: "local_discovery_ping", schema: LocalDiscoveryPingSchema.toJSONSchema() },
  { name: "local_discovery_pong", schema: LocalDiscoveryPongSchema.toJSONSchema() },
  { name: "local_challenge", schema: LocalChallengePayloadSchema.toJSONSchema() },
  { name: "local_challenge_response", schema: LocalChallengeResponsePayloadSchema.toJSONSchema() },
  { name: "local_auth_result", schema: LocalAuthResultPayloadSchema.toJSONSchema() },
  { name: "error", schema: ErrorPayloadSchema.toJSONSchema() },
  { name: "event", schema: EventPayloadSchema.toJSONSchema() },
];

const outputDir = dirname(fileURLToPath(import.meta.url)) + "/../schemas";
const manifest: { schema_version: string; default_snapshot_chunk_size: number; messages: Record<string, string> } = {
  schema_version: CURRENT_SCHEMA_VERSION,
  default_snapshot_chunk_size: DEFAULT_SNAPSHOT_CHUNK_SIZE,
  messages: {},
};

mkdirSync(outputDir, { recursive: true });

let count = 0;
for (const entry of entries) {
  const filename = `${entry.name}.schema.json`;
  const file = join(outputDir, filename);
  writeFileSync(file, JSON.stringify(entry.schema, null, 2) + "\n");
  // Store paths relative to the schemas/ directory so the manifest is portable
  // across machines and CI checkouts.
  manifest.messages[entry.name] = filename;
  count += 1;
}

writeFileSync(
  join(outputDir, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

console.log(`Generated ${count} JSON Schema files in ${outputDir}`);
