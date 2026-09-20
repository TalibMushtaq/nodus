// Native DownloadDeps for the shared SDK download/decrypt core.
//
// FEK comes from the SQLite key store (this device's own upload) or from the
// device's sealed Relay envelope; shard locations come from `GET /files`; shard
// bytes prefer a trusted LAN node and fall back to the Relay's pull-through.

import { type DownloadDeps, type DownloadTransport } from "@repo/sdk";
import {
  NodeClient,
  identityPrivateKey,
  nodusBaseUrl,
  signDeviceMessage,
  type StoredDeviceIdentity,
} from "@repo/relay-client";

import { fetchRelayShard, relayFiles } from "../relay";
import { getTrustedNodes } from "../store/trusted-nodes";
import { fetchMobileFileKey } from "./keys";

/** Pull one stored shard directly from a node over WebRTC (app-bound). */
export interface MobileWebRtcShardFetch {
  (args: {
    fileId: string;
    versionNumber: number;
    shardIndex: number;
    hash: string;
    size: number;
    nodeId: string;
    /** Cumulative bytes received for this shard, as chunks arrive. */
    onProgress?: (receivedBytes: number, totalBytes: number) => void;
  }): Promise<Uint8Array>;
}

export function mobileDownloadDeps(
  device: StoredDeviceIdentity,
  onTransport?: (transport: DownloadTransport) => void,
  fetchViaWebRtc?: MobileWebRtcShardFetch,
): DownloadDeps {
  return {
    onTransport,
    fetchFileKey: (fileId) => fetchMobileFileKey(device, fileId),

    async getShardLocations(fileId) {
      const files = await relayFiles();
      return files.find((f) => f.file_id === fileId)?.locations ?? [];
    },

    async fetchShard(fileId, location, onProgress) {
      if (!location.hash) throw new Error("shard location has no hash");
      // Direct WebRTC pull first (LAN-preferred, relay-signaling fallback); any
      // failure falls through to the HTTP paths below.
      if (location.status === "NODE_STORED" && fetchViaWebRtc) {
        try {
          const data = await fetchViaWebRtc({
            fileId,
            versionNumber: location.version_number,
            shardIndex: location.shard_index,
            hash: location.hash,
            size: location.size_bytes ?? 0,
            nodeId: location.node_id,
            onProgress,
          });
          onTransport?.("webrtc");
          return data;
        } catch {
          // Fall through to LAN HTTP, then the Relay.
        }
      }
      // Direct LAN fetch first (device-authenticated), then the Relay fallback.
      // A buffered shard is not on the node yet, so skip straight to the Relay,
      // which serves its buffer.
      const host =
        location.status === "NODE_STORED"
          ? (await getTrustedNodes()).find((n) => n.node_id === location.node_id)?.host
          : undefined;
      if (host) {
        try {
          const client = new NodeClient(nodusBaseUrl(host));
          // Mobile keeps its Ed25519 seed in the keychain; wrap it as a signer.
          const data = await client.fetchShard(
            device.device_id,
            (message) => signDeviceMessage(identityPrivateKey(device), message),
            location.hash,
            onProgress,
          );
          onTransport?.("lan");
          return data;
        } catch {
          // Unpaired/unreachable/auth-rejected: fall through to the Relay.
        }
      }
      onTransport?.("relay");
      return fetchRelayShard(location.hash, onProgress);
    },
  };
}
