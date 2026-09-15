// Native UploadDeps for the shared SDK uploader.
//
// Wires the SDK's injected side effects to the mobile platform: shard transport
// (Path C for now), sync-event batches over the Relay socket, sequence/FEK/
// progress persistence in SQLite, the device signing key, and §25 envelope
// publication to every active device/node.

import {
  collectRecipients,
  envelopeEvent,
  sealFekForRecipients,
  type UploadDeps,
} from "@repo/sdk";
import { type EventPayload } from "@repo/protocol";
import {
  identityPrivateKey,
  identityPublicKey,
  signDeviceMessage,
  type StoredDeviceIdentity,
} from "@repo/relay-client";
import type { ShardTransferRequest } from "@repo/transfer-manager";

import { relayDevices, relayNodes } from "../relay";
import type { MobileTransferManager } from "../transfer/manager";
import { getFileKey, putFileKey } from "../store/keys";
import { nextOriginSequence } from "../store/sync-state";
import {
  clearUploadProgress,
  getUploadProgress,
  markShardComplete,
  saveUploadProgress,
} from "../store/upload-progress";
import { postShard } from "../transfer/buffer";
import type { MobileWs } from "../ws";

export function createMobileUploadDeps(
  ws: MobileWs,
  device: StoredDeviceIdentity,
  transfer?: MobileTransferManager | null,
): UploadDeps {
  const sign = (message: string) => signDeviceMessage(identityPrivateKey(device), message);

  return {
    // Route each shard through the Transfer Manager when available so the
    // A→B→C→D chain (and its persistent queue) applies; otherwise post straight
    // to the Relay buffer.
    postShard: async (dto) => {
      if (!transfer) return postShard(dto);
      const request: ShardTransferRequest = {
        transferId: dto.transferId,
        fileId: dto.fileId,
        versionNumber: dto.versionNumber,
        shardIndex: dto.shardIndex,
        data: dto.data,
        hash: dto.hash,
        targetNode: dto.targetNode as unknown as ShardTransferRequest["targetNode"],
        sourceDevice: dto.sourceDevice,
        onProgress: dto.onProgress,
      };
      const result = await transfer.manager.uploadShard(request);
      if (!result.success) throw new Error(result.error ?? "shard transfer failed");
      return result;
    },
    sendEventBatch: (events) => ws.sendEventBatch(events),
    allocateSequence: (originId) => nextOriginSequence(originId),
    putFileKey,
    getFileKey,
    saveProgress: saveUploadProgress,
    getProgress: getUploadProgress,
    markShardComplete,
    clearProgress: clearUploadProgress,
    // Signs the per-shard manifest so the node can verify the whole version.
    signManifest: sign,
    publishEnvelopes: async (fileId, fek) => {
      // Every active device, storage node, and this device get a sealed copy of
      // the FEK before shards move, so any recipient can decrypt the file.
      const recipients = await collectRecipients(
        { deviceId: device.device_id, edPublicKey: identityPublicKey(device) },
        { listDevices: relayDevices, listNodes: relayNodes },
      );
      const sealed = sealFekForRecipients(fek, recipients);
      // One batch, one sequence per event; KEY_ENVELOPE_ADDED is projected by
      // the Relay and the node.
      const events: EventPayload[] = [];
      for (const envelope of sealed) {
        const sequence = await nextOriginSequence(device.device_id);
        events.push(envelopeEvent(device.device_id, sequence, fileId, envelope));
      }
      await ws.sendEventBatch(events);
    },
  };
}
