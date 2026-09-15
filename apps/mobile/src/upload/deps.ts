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

import { relayDevices, relayNodes } from "../relay";
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

export function createMobileUploadDeps(ws: MobileWs, device: StoredDeviceIdentity): UploadDeps {
  const sign = (message: string) => signDeviceMessage(identityPrivateKey(device), message);

  return {
    postShard: (dto) => postShard(dto),
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
