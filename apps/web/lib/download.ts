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
export type { DownloadDeps, DownloadFileOptions, DownloadResult, RelayFileLocation } from "@repo/sdk";

/**
 * Browser deps: FEK from the device's envelope, locations from the cached
 * catalog, shards from the trusted LAN node that stores them.
 */
export function browserDownloadDeps(
  device: DevicePublicIdentity,
  signer: DeviceSigner,
): DownloadDeps {
  return {
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
    async fetchShard(_fileId, location) {
      // Preferred path: a trusted LAN host for the storing node. If the LAN
      // fetch fails for ANY reason (no longer paired, node unreachable, auth
      // reject, timeout) we fall through to the Relay-mediated path instead of
      // failing the download — the Relay pulls the shard from the node over
      // its authenticated WS connection (design A).
      if (location.hash) {
        const nodes = await getTrustedNodes();
        const host = nodes.find((n) => n.node_id === location.node_id)?.host;
        if (host) {
          try {
            const client = new NodeClient(nodusBaseUrl(host));
            return await client.fetchShard(device.device_id, (message) => signer.sign(message), location.hash);
          } catch {
            // Fall through to the Relay path below.
          }
        }
        const viaRelay = await fetchShardViaRelay(location.hash);
        if (viaRelay.ok) return viaRelay.data as Uint8Array;
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
