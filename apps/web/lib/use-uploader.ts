"use client";

import { useCallback, useRef } from "react";
import { identityPublicKey } from "@repo/relay-client";
import { MessageTypes } from "@repo/protocol";
import type { BatchAckPayload, EventPayload } from "@repo/protocol";

import { useAuth } from "../providers/auth-provider";
import { useWs } from "../providers/ws-provider";
import { collectRecipients, envelopeEvent, sealFekForRecipients } from "./envelopes";
import { nextOriginSequence } from "./sync-state";
import { browserUploadDeps } from "./upload-deps";
import { uploadFile } from "./uploader";
import type { UploadProgressEvent, UploadResult } from "./uploader";

const EVENT_ACK_TIMEOUT_MS = 10_000;

/**
 * Browser Path C upload entry point. Wires the uploader's injected deps to the
 * app's WebSocket (for sync events) and IndexedDB (FEK + progress).
 */
export function useUploader(onProgress?: (event: UploadProgressEvent) => void) {
  const { device } = useAuth();
  const { send, on } = useWs();
  // The Relay's batch_ack carries no correlation id, so serialize event
  // batches: two overlapping uploads must not race for the same ack.
  const pendingRef = useRef<Promise<unknown>>(Promise.resolve());

  const sendEventBatch = useCallback(
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

  // Seal the FEK for this device plus every other active device and storage
  // node, then publish the envelopes as sync events (§25 F2).
  const publishEnvelopes = useCallback(
    async (fileId: string, fek: Uint8Array): Promise<void> => {
      if (!device) {
        throw new Error("no device identity available for key envelopes");
      }
      const recipients = await collectRecipients({
        deviceId: device.device_id,
        edPublicKey: identityPublicKey(device),
      });
      const sealed = sealFekForRecipients(fek, recipients);
      const events: EventPayload[] = [];
      for (const envelope of sealed) {
        const sequence = await nextOriginSequence(device.device_id);
        events.push(envelopeEvent(device.device_id, sequence, fileId, envelope));
      }
      const ack = await sendEventBatch(events);
      if (ack && ack.ok === false) {
        throw new Error(`key envelope batch rejected: ${ack.reason ?? "unknown"}`);
      }
    },
    [device, sendEventBatch],
  );

  const upload = useCallback(
    async (file: File, targetNode: string): Promise<UploadResult> => {
      if (!device) {
        throw new Error("no device identity available for upload");
      }
      return uploadFile({
        file,
        originId: device.device_id,
        targetNode,
        sourceDevice: device.device_id,
        deps: browserUploadDeps({ sendEventBatch, publishEnvelopes }),
        onProgress,
      });
    },
    [device, sendEventBatch, publishEnvelopes, onProgress],
  );

  return { upload, ready: Boolean(device) };
}
