import { z } from "zod";

// ── Account-wide activity feed (Relay REST + Node LAN) ───────────────
//
// The same record shape is returned by the Relay's `GET /activities` and the
// Storage Node's `GET /nodus/activities`, so a client parses one type either
// way. Entries deliberately carry no file name: names are E2E and neither the
// Relay nor the Node may see them. `file_id` lets each client resolve the
// display name from its own decrypted catalog/tombstone.

export const ActivityKindSchema = z.enum([
  "upload",
  "download",
  "delete",
  "restore",
  "purge",
  "rename",
  "move",
  "conflict",
]);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export const ActivityOutcomeSchema = z.enum(["complete", "failed"]);
export type ActivityOutcome = z.infer<typeof ActivityOutcomeSchema>;

/** One activity entry as served by the Relay or a Storage Node. */
export const ActivityRecordSchema = z.object({
  /** Client-generated uuid; the feed's dedupe key. */
  activity_id: z.string(),
  kind: ActivityKindSchema,
  outcome: ActivityOutcomeSchema,
  /** File the action concerned, when file-scoped. */
  file_id: z.string().nullable().optional(),
  /** Transfer path vocabulary. */
  path: z.string().nullable().optional(),
  /** Non-sensitive summary or error text. */
  detail: z.string().nullable().optional(),
  /** When the action finished, ISO 8601. */
  created_at: z.string(),
  /** Origin device that produced the entry. */
  device_id: z.string(),
});
export type ActivityRecord = z.infer<typeof ActivityRecordSchema>;

/** Response body for both activity endpoints. */
export const ActivityListSchema = z.object({
  activities: z.array(ActivityRecordSchema),
});
export type ActivityList = z.infer<typeof ActivityListSchema>;
