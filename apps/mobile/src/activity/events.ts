// Build the `ACTIVITY_LOGGED` sync event for a locally-recorded terminal
// activity. The payload deliberately carries no file name (names are E2E; the
// Relay and Node must not see them) — each client resolves the display name
// from its own decrypted catalog by `file_id`.

import { EventTypes, type EventPayload } from "@repo/protocol";

import type { TransferLogEntry } from "../store/transfer-log";

export function activityLoggedEvent(
  originId: string,
  sequence: number,
  entry: TransferLogEntry,
): EventPayload {
  return {
    event_id: crypto.randomUUID() as EventPayload["event_id"],
    origin_id: originId,
    origin_sequence: sequence,
    type: EventTypes.ACTIVITY_LOGGED,
    payload: {
      activity_id: entry.id,
      kind: entry.kind,
      outcome: entry.outcome,
      file_id: entry.fileId,
      path: entry.path,
      detail: entry.detail,
      created_at: entry.createdAt,
    },
    timestamp: new Date().toISOString(),
  };
}
