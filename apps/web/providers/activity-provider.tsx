"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { activityLoggedEvent } from "../lib/activity-events";
import { nextOriginSequence } from "../lib/sync-state";
import { listUnsyncedTransfers, markTransfersSynced } from "../lib/transfer-log";
import { useEventBatch } from "../lib/use-event-batch";
import { useAuth } from "./auth-provider";
import { useWs } from "./ws-provider";

// Uploads this browser's locally-recorded activity to the account-wide feed as
// `ACTIVITY_LOGGED` sync events. Runs in the background (not the Activity page)
// so an action performed on Files reaches the Relay/Node even if Activity is
// never opened. Entries logged while offline stay unsynced and are retried on
// the next tick / reconnect, so the feed converges once connectivity returns.

const FLUSH_INTERVAL_MS = 20_000;
/** Bound per flush so a large backlog does not monopolize the socket. */
const MAX_EVENTS_PER_FLUSH = 50;

export function ActivityProvider({ children }: { children: ReactNode }) {
  const { device } = useAuth();
  const { status } = useWs();
  const sendEventBatch = useEventBatch();
  const runningRef = useRef(false);

  const flush = useCallback(async () => {
    if (!device || runningRef.current) return;
    runningRef.current = true;
    try {
      const pending = (await listUnsyncedTransfers()).slice(0, MAX_EVENTS_PER_FLUSH);
      if (pending.length === 0) return;
      // One sequence per event; the batch is acked as a unit.
      const events = [];
      for (const entry of pending) {
        const sequence = await nextOriginSequence(device.device_id);
        events.push(activityLoggedEvent(device.device_id, sequence, entry));
      }
      const ack = await sendEventBatch(events);
      if (ack && ack.ok !== false) {
        await markTransfersSynced(pending.map((entry) => entry.id));
      }
    } catch {
      // Best-effort: leave the entries unsynced and retry on the next tick.
    } finally {
      runningRef.current = false;
    }
  }, [device, sendEventBatch]);

  useEffect(() => {
    if (!device || status !== "connected") return;
    // Flush once on connect, then periodically for entries created while open.
    void flush();
    const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [device, status, flush]);

  return <>{children}</>;
}
