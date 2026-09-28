"use client";

import { useCallback } from "react";
import { MessageTypes } from "@repo/protocol";
import type { BatchAckPayload, EventPayload } from "@repo/protocol";

import { useWs } from "../providers/ws-provider";

const EVENT_ACK_TIMEOUT_MS = 10_000;

// One serialization queue for the whole tab, not one per hook instance.
//
// The Relay's `batch_ack` carries no correlation id (the protocol's optional
// `batch_id` is never populated by the device-batch handler). With a queue per
// `useEventBatch()` call site, the seven callers (uploader, file/folder
// mutations, activity, recovery reset, envelope backfill, conflicts) could each
// have a batch in flight at once and resolve on *each other's* ack, marking
// events synced that were never applied. A single module-level chain keeps
// exactly one batch in flight per tab, so an ack can only belong to the batch
// that is actually waiting for it.
//
// Residual limitation: ack correlation is still absent, so a batch that times
// out and whose ack arrives late could in principle satisfy the next batch.
// Fully closing that needs the batch id echoed on the ack (a protocol change).
let batchQueue: Promise<unknown> = Promise.resolve();

/**
 * Send one sync-event batch and resolve with its ack.
 *
 * All callers share the tab-wide queue so overlapping batches never race for
 * the same ack.
 */
export function useEventBatch() {
  const { send, on } = useWs();

  return useCallback(
    (events: EventPayload[]): Promise<BatchAckPayload> => {
      const run = () =>
        new Promise<BatchAckPayload>((resolve, reject) => {
          let off: () => void = () => undefined;
          const timer = setTimeout(() => {
            off();
            reject(new Error("timed out waiting for batch_ack"));
          }, EVENT_ACK_TIMEOUT_MS);
          off = on("batch_ack", (payload) => {
            clearTimeout(timer);
            off();
            resolve(payload as BatchAckPayload);
          });
          send({ type: MessageTypes.EVENT_BATCH, payload: { events } });
        });
      // Chain so batches leave in arrival order and resolve against their own ack.
      const next = batchQueue.then(run, run);
      batchQueue = next.catch(() => undefined);
      return next;
    },
    [on, send],
  );
}
