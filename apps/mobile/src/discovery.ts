/**
 * LAN discovery for mobile.
 *
 * `discoverNodes` prefers native mDNS (`react-native-zeroconf`, see `./mdns`)
 * and falls back to a bounded /24 sweep when mDNS is unavailable, denied, or
 * finds nothing: read this device's IPv4 from expo-network and probe every
 * neighbour's `/nodus/discovery` (the same endpoint mDNS advertises). The
 * native mDNS modules need a custom development build (they cannot load in
 * Expo Go), so the sweep keeps discovery working on any build and is also the
 * manual fallback. Per ADR-0004, Path A is attempted foreground-only.
 */

import * as Network from "expo-network";

import {
  fetchAdvertisement,
  nodusBaseUrl,
} from "@repo/relay-client/local-discovery";

import { browseNodes } from "./mdns";

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
        // hosts is 1-indexed by last octet, so the self host is idx+1.
        if (idx + 1 === ownLast) continue;
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

/** Outcome of a discovery attempt, including whether local access was allowed. */
export interface DiscoveryOutcome {
  candidates: LanCandidate[];
  /** False when the OS denied local-network access (mDNS browse error). */
  permitted: boolean;
  method: "mdns" | "lan_sweep" | "none";
}

/**
 * Discover nodes, preferring native mDNS and falling back to the /24 sweep.
 *
 * The fallback matters on two fronts: mDNS may be blocked by an OEM or the
 * permission denied, and the sweep covers a node whose mDNS advert was missed.
 * When the permission is denied we still run the sweep, but the caller is told
 * `permitted: false` so it can show the ADR-0004 fallback message.
 */
export async function discoverNodes(): Promise<DiscoveryOutcome> {
  const mdns = await browseNodes();
  if (mdns.permitted && mdns.candidates.length > 0) {
    return { candidates: mdns.candidates, permitted: true, method: "mdns" };
  }

  const myIp = await myLanV4();
  if (!myIp) {
    return { candidates: mdns.candidates, permitted: mdns.permitted, method: "none" };
  }
  const swept = await scanLan(myIp);
  return { candidates: swept, permitted: mdns.permitted, method: "lan_sweep" };
}