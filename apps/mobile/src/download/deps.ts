// Native DownloadDeps for the shared SDK download/decrypt core.
//
// FEK comes from the SQLite key store (this device's own upload) or from the
// device's sealed Relay envelope; shard locations come from `GET /files`; shard
// bytes prefer a trusted LAN node and fall back to the Relay's pull-through.

import { openFekFromEnvelope, type DownloadDeps } from "@repo/sdk";
import {
  NodeClient,
  identityPrivateKey,
  nodusBaseUrl,
  type StoredDeviceIdentity,
} from "@repo/relay-client";

import { fetchRelayShard, relayEnvelopes, relayFiles } from "../relay";
import { getFileKey } from "../store/keys";
import { getTrustedNodes } from "../store/trusted-nodes";

export function mobileDownloadDeps(device: StoredDeviceIdentity): DownloadDeps {
  return {
    async fetchFileKey(fileId) {
      // A locally cached FEK (this device's own upload) avoids a Relay round
      // trip; otherwise open this device's sealed envelope.
      const local = await getFileKey(fileId);
      if (local) return local;
      const envelopes = await relayEnvelopes(fileId);
      const mine = envelopes.find((e) => e.recipient_id === device.device_id);
      if (!mine) return null;
      return openFekFromEnvelope(mine.encrypted_key, identityPrivateKey(device));
    },

    async getShardLocations(fileId) {
      const files = await relayFiles();
      return files.find((f) => f.file_id === fileId)?.locations ?? [];
    },

    async fetchShard(_fileId, location) {
      if (!location.hash) throw new Error("shard location has no hash");
      // Direct LAN fetch first (device-authenticated), then the Relay fallback.
      const host = (await getTrustedNodes()).find((n) => n.node_id === location.node_id)?.host;
      if (host) {
        try {
          const client = new NodeClient(nodusBaseUrl(host));
          return await client.fetchShard(device.device_id, identityPrivateKey(device), location.hash);
        } catch {
          // Unpaired/unreachable/auth-rejected: fall through to the Relay.
        }
      }
      return fetchRelayShard(location.hash);
    },
  };
}
