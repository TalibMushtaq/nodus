import { z } from "zod";
import { NodeId } from "../types.js";

// ── Rebuild Required ───────────────────────────────────────────────

/**
 * Relay → Node request to initiate a full snapshot / rebuild (§20).
 *
 * Sent when the Relay needs to reconstruct its account state (e.g. PostgreSQL
 * restored from backup, schema mismatch, or a manual admin trigger). The Relay
 * routes this to the account's designated primary Storage Node only; a
 * non-primary node's snapshot is never used to rebuild the Relay.
 *
 * This is deliberately separate from `reconcile`, which is scoped to §21
 * node-local physical reconciliation (SQLite metadata vs. disk). Overloading
 * `reconcile` to also mean "rebuild the Relay's entire account state" would
 * conflate two different failure domains.
 */
export const RebuildRequiredPayloadSchema = z.object({
  /** The primary node being asked to produce a snapshot. */
  node_id: NodeId,
  /** Why the rebuild was requested (admin, restore, schema_mismatch). */
  reason: z.enum(["admin", "restore", "schema_mismatch"]),
  /** BLAKE3 content hash of the Relay's current state, if known; empty if none. */
  expected_content_hash: z.string().optional(),
});

export type RebuildRequiredPayload = z.infer<typeof RebuildRequiredPayloadSchema>;
