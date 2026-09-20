// Web binding for the shared @repo/sdk download/decrypt core.
//
// The fetch/verify/decrypt/reassemble logic lives in the SDK; this file adds
// the browser deps (FEK from IndexedDB or the device's Relay envelope, shard
// locations from the cached catalog, shards from a trusted LAN node with a
// Relay-mediated fallback) and the Relay shard proxy helper.

import { NodeClient, nodusBaseUrl } from "@repo/relay-client";
import {
  ShardUnavailableError,
  type DevicePublicIdentity,
  type DeviceSigner,
  type DownloadDeps,
  type DownloadTransport,
} from "@repo/sdk";

import { getCachedCatalog } from "./catalog";
import { fetchAndOpenFileKey } from "./envelopes";
import { getFileKey } from "./keys";
import { getTrustedNodes } from "./trusted-nodes";

export {
  downloadFile,
  MissingEnvelopeError,
  ShardUnavailableError,
  ShardIntegrityError,
} from "@repo/sdk";
export type {
  DownloadDeps,
  DownloadFileOptions,
  DownloadResult,
  DownloadTransport,
  RelayFileLocation,
} from "@repo/sdk";

/** Pull one stored shard directly from a node over WebRTC (provider-bound). */
export interface WebRtcShardFetch {
  (args: {
    fileId: string;
    versionNumber: number;
    shardIndex: number;
    hash: string;
    size: number;
    nodeId: string;
  }): Promise<Uint8Array>;
}

/**
 * Browser deps: FEK from the device's envelope, locations from the cached
 * catalog, shards from a trusted LAN node or the Relay. When a `fetchViaWebRtc`
 * binding is supplied, a direct data-channel pull is attempted first.
 *
 * `onTransport` is called with the transport that actually served each shard so
 * the widget/page can label the download ("Local P2P" / "WebRTC" vs "Relay
 * buffer"). It is advisory: the SDK never awaits it and a throw is swallowed.
 */
export function browserDownloadDeps(
  device: DevicePublicIdentity,
  signer: DeviceSigner,
  onTransport?: (transport: DownloadTransport) => void,
  fetchViaWebRtc?: WebRtcShardFetch,
): DownloadDeps {
  return {
    onTransport,
    async fetchFileKey(fileId) {
      // Prefer the locally cached FEK (this device's own upload, or a key
      // materialized from a recovery envelope), then fall back to this device's
      // Relay envelope for a file uploaded elsewhere.
      const local = await getFileKey(fileId);
      if (local) return local;
      return fetchAndOpenFileKey(fileId, device.device_id);
    },
    async getShardLocations(fileId) {
      const catalog = await getCachedCatalog();
      const entry = catalog.find((c) => c.file_id === fileId);
      return entry?.locations ?? [];
    },
    async fetchShard(fileId, location) {
      // Direct WebRTC pull first: the node stores the ciphertext, so a
      // NODE_STORED shard can be streamed over a data channel (LAN-preferred,
      // relay-signaling fallback). Any failure falls through to the HTTP paths.
      if (location.hash && location.status === "NODE_STORED" && fetchViaWebRtc) {
        try {
          const data = await fetchViaWebRtc({
            fileId,
            versionNumber: location.version_number,
            shardIndex: location.shard_index,
            hash: location.hash,
            size: location.size_bytes ?? 0,
            nodeId: location.node_id,
          });
          onTransport?.("webrtc");
          return data;
        } catch {
          // Fall through to LAN HTTP, then the Relay.
        }
      }
      // Preferred path: a trusted LAN host for the storing node. A buffered
      // shard is not on the node yet, so skip the LAN attempt and go straight
      // to the Relay (which serves its buffer). If a LAN fetch fails for ANY
      // reason we fall through to the Relay-mediated path instead of failing —
      // the Relay pulls the shard from the node over its authenticated WS
      // connection, or serves it from its own buffer (design A).
      if (location.hash) {
        const nodes = await getTrustedNodes();
        const host = location.status === "NODE_STORED" ? nodes.find((n) => n.node_id === location.node_id)?.host : undefined;
        if (host) {
          try {
            const client = new NodeClient(nodusBaseUrl(host));
            const data = await client.fetchShard(device.device_id, (message) => signer.sign(message), location.hash);
            onTransport?.("lan");
            return data;
          } catch {
            // Fall through to the Relay path below.
          }
        }
        const viaRelay = await fetchShardViaRelay(location.hash);
        if (viaRelay.ok) {
          onTransport?.("relay");
          return viaRelay.data as Uint8Array;
        }
        throw new ShardUnavailableError(location.shard_index, viaRelay.error ?? "relay_unavailable");
      }
      throw new ShardUnavailableError(location.shard_index, "no_trusted_host");
    },
  };
}

export interface RelayShardFetchResult {
  ok: boolean;
  data?: Uint8Array;
  error?: string;
}

/**
 * Fetch a stored shard through the Relay (design A). The Relay finds which of
 * the account's nodes holds the object, pulls it over their authenticated WS
 * connection, and streams the raw ciphertext bytes back. Only ever a fallback
 * — the direct LAN fetch is preferred when a trusted host exists.
 */
export async function fetchShardViaRelay(hash: string): Promise<RelayShardFetchResult> {
  try {
    const res = await fetch(`/api/shard/${encodeURIComponent(hash)}`);
    if (!res.ok) {
      let message = `relay shard fetch failed: ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        // Non-JSON error body; keep the HTTP status message.
      }
      return { ok: false, error: message };
    }
    return { ok: true, data: new Uint8Array(await res.arrayBuffer()) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
