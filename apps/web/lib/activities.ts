import { NodeClient, nodusBaseUrl } from "@repo/relay-client";
import { ActivityListSchema, type ActivityRecord } from "@repo/protocol";

import { getTrustedNodes } from "./trusted-nodes";
import type { RelayDevice } from "./pairing";
import { shortId } from "./format";

// Account-wide activity feed fetch/attribution. The feed is served by the Relay
// (`/api/activities` BFF proxy) when online and by a paired Storage Node over
// the LAN (`/nodus/activities`, signed device request) when offline, so the
// Activity view reads the same records either way.

/** Online path: the Relay feed via the session-cookie BFF proxy. */
export async function fetchRelayActivities(limit = 200): Promise<ActivityRecord[]> {
  const res = await fetch(`/api/activities?limit=${limit}`);
  if (!res.ok) throw new Error(`activity fetch failed: ${res.status}`);
  return ActivityListSchema.parse(await res.json()).activities;
}

/**
 * Offline path: ask each trusted node over the LAN until one answers. The node
 * is bound to this account, so the first reachable trusted node is sufficient.
 * Never throws — returns an empty list when no node answers so the caller falls
 * back to whatever is cached locally.
 */
export async function fetchNodeActivities(
  deviceId: string,
  sign: (message: string) => string | Promise<string>,
): Promise<ActivityRecord[]> {
  const nodes = await getTrustedNodes();
  for (const node of nodes) {
    try {
      return await new NodeClient(nodusBaseUrl(node.host)).listActivities(deviceId, sign);
    } catch {
      // Unreachable or rejected; try the next trusted host.
    }
  }
  return [];
}

/**
 * A human label for the device that performed an action: its account name when
 * set, else the auto-captured platform/browser string ("Linux · Chrome 126"),
 * else a short id. `describe` is injected so both clients share the logic.
 */
export function deviceLabel(
  deviceId: string,
  devices: RelayDevice[],
  describe: (info: RelayDevice["device_info"]) => string | null,
  thisDeviceId?: string,
): string {
  const device = devices.find((candidate) => candidate.device_id === deviceId);
  const named = device?.display_name?.trim();
  if (named) return named;
  const described = describe(device?.device_info ?? null);
  if (described) return described;
  if (thisDeviceId && deviceId === thisDeviceId) return "This device";
  return shortId(deviceId);
}
