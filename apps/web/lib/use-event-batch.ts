"use client";

import { useCallback, useRef } from "react";
import { MessageTypes } from "@repo/protocol";
import type { BatchAckPayload, EventPayload } from "@repo/protocol";

import { useWs } from "../providers/ws-provider";

const EVENT_ACK_TIMEOUT_MS = 10_000;

/**
 * Send one sync-event batch and resolve with its ack.
 *
 * The Relay's `batch_ack` carries no correlation id, so calls are serialized:
 * two overlapping batches must not race for the same ack. Shared by the uploader
 * (file/version/envelope events) and the file mutations (rename/delete).
 */
export function useEventBatch() {
  const { send, on } = useWs();
  const pendingRef = useRef<Promise<unknown>>(Promise.resolve());

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
      const next = pendingRef.current.then(run, run);
      pendingRef.current = next.catch(() => undefined);
      return next;
    },
    [on, send],
  );
}
