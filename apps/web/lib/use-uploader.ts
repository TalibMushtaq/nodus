"use client";

import { useCallback } from "react";
import { identityPublicKey } from "@repo/relay-client";
import type { EventPayload } from "@repo/protocol";

import { useAuth } from "../providers/auth-provider";
import { collectRecipients, envelopeEvent, sealFekForRecipients } from "./envelopes";
import { nextOriginSequence } from "./sync-state";
import { useEventBatch } from "./use-event-batch";
import { browserUploadDeps } from "./upload-deps";
import { uploadFile } from "./uploader";
import type { FileMeasurement, UploadProgressEvent, UploadResult } from "./uploader";
import type { ShardUpload, ShardUploadResult } from "./buffer";

/**
 * Browser upload entry point. Wires the uploader's injected deps to the app's
 * WebSocket (for sync events) and IndexedDB (FEK + progress).
 *
 * `postShardOverride` lets the caller route each shard through the Transfer
 * Manager's path chain (direct LAN WebRTC → relay signaling → relay buffer →
 * local queue). Without it, shards go straight to the Relay buffer (Path C).
 */
export function useUploader(
  onProgress?: (event: UploadProgressEvent) => void,
  postShardOverride?: (dto: ShardUpload) => Promise<ShardUploadResult>,
) {
  const { device } = useAuth();
  const sendEventBatch = useEventBatch();

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
    async (
      file: File,
      targetNode: string,
      measurement?: FileMeasurement,
      target?: { fileId: string; versionNumber: number },
    ): Promise<UploadResult> => {
      if (!device) {
        throw new Error("no device identity available for upload");
      }
      return uploadFile({
        file,
        originId: device.device_id,
        targetNode,
        sourceDevice: device.device_id,
        // Resuming an existing incomplete file reuses its ids so the uploader
        // picks up its persisted progress instead of creating a duplicate.
        fileId: target?.fileId,
        versionNumber: target?.versionNumber,
        deps: browserUploadDeps({
          sendEventBatch,
          publishEnvelopes,
          ...(postShardOverride ? { postShard: postShardOverride } : {}),
        }),
        onProgress,
        // Pass the precomputed measurement so the uploader does not re-read the
        // file after the Files UI hashed it for the duplicate check.
        versionHash: measurement?.versionHash,
        shardCount: measurement?.shardCount,
      });
    },
    [device, sendEventBatch, publishEnvelopes, onProgress, postShardOverride],
  );

  return { upload, ready: Boolean(device) };
}
