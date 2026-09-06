/**
 * LAN discovery for mobile.
 *
 * Design decision G called for evaluating native mDNS libraries first.
 * `react-native-zeroconf`/`react-native-dns-sd` are native modules: they need
 * a custom development build and cannot load in Expo Go, and their APIs are
 * largely unmaintained. Until a native build is wired up, discovery is a
 * bounded pure-JS sweep: read this device's IPv4 from expo-network, then probe
 * every /24 neighbour's `/nodus/discovery` (same endpoint mDNS would have
 * advertised). This works on any Expo Go build and is what the manual
 * fallback uses anyway — see CHANGELOG for the native-mDNS follow-up.
 */

import * as Network from "expo-network";

import {
  fetchAdvertisement,
  nodusBaseUrl,
} from "@repo/relay-client/local-discovery";

/** Reachable storage node found on the LAN sweep. */
export interface LanCandidate {
  host: string;
  /** node_id + schema_version from the node's own advertisement. */
  node_id: string;
  schema_version: string;
}

/** Single IPv4 probe timeout for scan hosts (short: unreachable hosts wait). */
const SCAN_TIMEOUT_MS = 800;
/** Hosts probed concurrently — keeps the sweep fast without hammering the LAN. */
const SCAN_CONCURRENCY = 12;

export async function myLanV4(): Promise<string | null> {
  const ip = await Network.getIpAddressAsync();
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return null;
  }
  if (parts.slice(0, 3).join(".") === "0.0.0") return null;
  return ip;
}

/** Probe one host manually (manual-entry fallback). Throws on failure. */
export async function probeHost(host: string): Promise<LanCandidate> {
  const adv = await fetchAdvertisement(nodusBaseUrl(host));
  return { host, node_id: adv.node_id, schema_version: adv.schema_version };
}

/**
 * Sweep the /24 subnet of `myIp` for storage nodes. Hosts that don't answer
 * within the probe timeout are skipped silently — a node may be behind a
 * per-host firewall.
 */
export async function scanLan(myIp: string): Promise<LanCandidate[]> {
  const parts = myIp.split(".");
  const prefix = parts.slice(0, 3).join(".");
  const ownLast = Number(parts[3]);

  const results: LanCandidate[] = [];
  let cursor = 0;
  const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);

  await Promise.all(
    Array.from({ length: SCAN_CONCURRENCY }, async () => {
      while (cursor < hosts.length) {
        const idx = cursor;
        cursor += 1;
        const host = hosts[idx];
        if (idx === ownLast) continue;
        try {
          const adv = await fetchAdvertisement(nodusBaseUrl(host), SCAN_TIMEOUT_MS);
          results.push({ host, node_id: adv.node_id, schema_version: adv.schema_version });
        } catch {
          // No listener → not a Nodus node (or node behind firewall). Skip.
        }
      }
    }),
  );

  return results.sort((a, b) => a.host.localeCompare(b.host));
}