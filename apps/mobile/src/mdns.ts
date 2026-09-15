/**
 * Native mDNS discovery for Storage Nodes (Path A prerequisite).
 *
 * ADR-0004 chose Expo CNG with a native mDNS module, so this browses the
 * `_nodus._tcp` service the Rust node advertises (TXT: `node_id`, `v`, `pk_fp`)
 * instead of the old pure-JS /24 sweep. The sweep remains as a fallback when
 * mDNS is unavailable or the local-network permission is denied, because on
 * iOS a denied permission surfaces only as a failed/empty browse.
 *
 * Discovery is foreground-only (ADR-0004): callers must stop the browse on
 * backgrounding and must treat the result as an unverified network location —
 * trust is established later by node challenge-response, never by this record.
 */

import Zeroconf from "react-native-zeroconf";

import type { LanCandidate } from "./discovery";

export interface MdnsDiscovery {
  /** Reachable nodes discovered; empty when none answered or permission denied. */
  candidates: LanCandidate[];
  /**
   * False when the OS refused local-network access (browse error). Callers
   * show the explicit "local transfer unavailable" message and fall back to the
   * Relay path (ADR-0004), rather than presenting an empty list as "no nodes".
   */
  permitted: boolean;
}

/** TXT `v` is the protocol schema version; default it so a terse advert still parses. */
function parseCandidate(address: string, txt: Record<string, string>): LanCandidate | null {
  const nodeId = txt.node_id ?? "";
  if (!nodeId) return null;
  return { host: address, node_id: nodeId, schema_version: txt.v ?? "1" };
}

/** First IPv4 in the advert, else the first address of any family. */
function preferIpv4(addresses: string[]): string | undefined {
  return addresses.find((a) => a.includes(".")) ?? addresses[0];
}

/**
 * Browse `_nodus._tcp` for `timeoutMs` and resolve the reachable nodes. Always
 * stops the scan; a thrown browse start is reported as `permitted: false` so
 * the caller can distinguish a permission problem from "nothing found".
 */
export function browseNodes(timeoutMs = 3000): Promise<MdnsDiscovery> {
  return new Promise((resolve) => {
    const zc = new Zeroconf();
    const candidates = new Map<string, LanCandidate>();
    let permitted = true;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        zc.stop();
        zc.removeAllListeners();
      } catch {
        // The native module may already be torn down; discovery is best-effort.
      }
      resolve({ candidates: [...candidates.values()], permitted });
    };

    const timer = setTimeout(finish, timeoutMs);

    zc.on("resolved", (service) => {
      const address = preferIpv4(service.addresses ?? []);
      if (!address) return;
      const candidate = parseCandidate(address, service.txt ?? {});
      // Key by node id so multiple resolved records (v4+v6) collapse to one.
      if (candidate) candidates.set(candidate.node_id, candidate);
    });

    zc.on("error", () => {
      // A browse error on iOS is the permission-denial signal; there is no
      // explicit prompt API to query.
      permitted = false;
      finish();
    });

    try {
      zc.scan("nodus", "tcp", "local.");
    } catch {
      permitted = false;
      finish();
    }
  });
}
