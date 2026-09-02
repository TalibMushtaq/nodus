import { z } from "zod";
import { EventPayloadSchema } from "../events/event-types.js";
import { NodeId } from "../types.js";

// ── Sync Cursor ────────────────────────────────────────────────────

/**
 * A sync cursor represents the last event origin_id/sequence pair a peer has
 * seen from a particular origin. Used in both `sync_hello` and `sync_status`
 * to compute which events each side is missing.
 */
export const SyncCursorSchema = z.object({
  origin_id: z.string(),
  /** Last known sequence number from this origin */
  sequence: z.number().int().min(0),
});

export type SyncCursor = z.infer<typeof SyncCursorSchema>;

// ── Sync Hello ─────────────────────────────────────────────────────

/**
 * Initial cursor-exchange handshake message (§18).
 * Sent by a node (or client) when it comes online to initiate incremental
 * sync. Contains the cursors for every origin the sender has seen, so the
 * receiver can compute the diff.
 */
export const SyncHelloPayloadSchema = z.object({
  node_id: NodeId,
  /** Cursors for every origin the sender has events from */
  cursors: z.array(SyncCursorSchema),
});

export type SyncHelloPayload = z.infer<typeof SyncHelloPayloadSchema>;

// ── Sync Status ────────────────────────────────────────────────────

/**
 * Response to `sync_hello`. Reports what the receiver knows, so the sender
 * can compute which events to send. Each cursor entry also carries
 * `known_count` — the total number of events from that origin the receiver
 * has — to help the sender assess how far behind the receiver is.
 */
export const SyncCursorWithCountSchema = SyncCursorSchema.extend({
  known_count: z.number().int().min(0),
});

export const SyncStatusPayloadSchema = z.object({
  node_id: NodeId,
  cursors: z.array(SyncCursorWithCountSchema),
});

export type SyncStatusPayload = z.infer<typeof SyncStatusPayloadSchema>;

// ── Event Batch ────────────────────────────────────────────────────

/**
 * Wraps one or more sync events for batch transport.
 * This is the "exact sync event schema" open item from Todo.md — the event
 * envelope (§15) and per-type payload schemas are finalized here and in
 * `src/events/event-types.ts`.
 */
export const EventBatchPayloadSchema = z.object({
  /** Events ordered by origin_sequence within each origin */
  events: z.array(EventPayloadSchema),
});

export type EventBatchPayload = z.infer<typeof EventBatchPayloadSchema>;

// ── Reconcile ──────────────────────────────────────────────────────

/**
 * Physical reconciliation signal (§21). Sent periodically (or triggered by
 * divergence detection) to compare what a node physically owns against what
 * the Relay expects. Carries a content hash / manifest reference rather
 * than full file lists — the receiver compares hashes and requests a full
 * snapshot only when they diverge.
 */
export const ReconcilePayloadSchema = z.object({
  node_id: NodeId,
  /** BLAKE3 content hash of the node's current file manifest */
  content_hash: z.string(),
  /** Sequence checkpoint at which this reconciliation was taken */
  checkpoint: z.number().int().min(0),
});

export type ReconcilePayload = z.infer<typeof ReconcilePayloadSchema>;
