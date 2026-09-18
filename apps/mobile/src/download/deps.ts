// Native DownloadDeps for the shared SDK download/decrypt core.
//
// FEK comes from the SQLite key store (this device's own upload) or from the
// device's sealed Relay envelope; shard locations come from `GET /files`; shard
// bytes prefer a trusted LAN node and fall back to the Relay's pull-through.

import { type DownloadDeps } from "@repo/sdk";
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

export function mobileDownloadDeps(device: StoredDeviceIdentity): DownloadDeps {
  return {
    fetchFileKey: (fileId) => fetchMobileFileKey(device, fileId),

    async getShardLocations(fileId) {
      const files = await relayFiles();
      return files.find((f) => f.file_id === fileId)?.locations ?? [];
    },

    async fetchShard(_fileId, location) {
      if (!location.hash) throw new Error("shard location has no hash");
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
          return await client.fetchShard(
            device.device_id,
            (message) => signDeviceMessage(identityPrivateKey(device), message),
            location.hash,
          );
        } catch {
          // Unpaired/unreachable/auth-rejected: fall through to the Relay.
        }
      }
      return fetchRelayShard(location.hash);
    },
  };
}
