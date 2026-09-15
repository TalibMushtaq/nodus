// Background queue drain (Phase 17).
//
// ADR-0004 keeps Path A foreground-only, so the only safe background delivery is
// the Relay buffer (Path C): the task hands each parked shard to the Relay,
// which forwards it to the node when it reconnects. This is deliberately not
// the full transfer manager — no LAN/WebRTC, no UI — just a headless POST loop.
//
// The task must be defined at module scope so it exists when the OS starts the
// app headlessly; `index.ts` imports this file for that reason.

import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";

import { getSessionToken } from "../adapters";
import { SqliteLocalQueue } from "../store/local-queue";
import { postShard } from "../transfer/buffer";

export const QUEUE_DRAIN_TASK = "nodus-queue-drain";

TaskManager.defineTask(QUEUE_DRAIN_TASK, async () => {
  try {
    // No session: nothing to deliver with; succeed so the OS does not back off.
    if (!(await getSessionToken())) return BackgroundTask.BackgroundTaskResult.Success;

    const queue = new SqliteLocalQueue();
    await queue.hydrate();

    // Stop at the first failure so a still-offline Relay is retried next run
    // rather than burning the whole background budget on doomed posts.
    while (queue.size > 0) {
      const item = queue.peek();
      if (!item) break;
      try {
        await postShard({
          fileId: item.fileId,
          versionNumber: item.versionNumber,
          shardIndex: item.shardIndex,
          hash: item.hash,
          size: item.data.length,
          targetNode: String(item.targetNode),
          transferId: item.transferId,
          sourceDevice: item.sourceDevice,
          data: item.data,
        });
        queue.dequeue();
      } catch {
        break;
      }
    }
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Register the periodic drain once (no-op where background tasks are unavailable). */
export async function registerBackgroundSync(): Promise<void> {
  if (!(await TaskManager.isAvailableAsync())) return;
  if (await TaskManager.isTaskRegisteredAsync(QUEUE_DRAIN_TASK)) return;
  // minimumInterval is in minutes; the OS decides the actual cadence.
  await BackgroundTask.registerTaskAsync(QUEUE_DRAIN_TASK, { minimumInterval: 15 });
}
