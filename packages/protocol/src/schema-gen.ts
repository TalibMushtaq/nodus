import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RegisterPayloadSchema,
  HeartbeatPayloadSchema,
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
  ReconcilePayloadSchema,
  SnapshotBeginPayloadSchema,
  SnapshotChunkPayloadSchema,
  SnapshotEndPayloadSchema,
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
  { name: "reconcile", schema: ReconcilePayloadSchema.toJSONSchema() },
  { name: "snapshot_begin", schema: SnapshotBeginPayloadSchema.toJSONSchema() },
  { name: "snapshot_chunk", schema: SnapshotChunkPayloadSchema.toJSONSchema() },
  { name: "snapshot_end", schema: SnapshotEndPayloadSchema.toJSONSchema() },
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
