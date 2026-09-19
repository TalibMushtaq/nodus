// Offline activity fetch: ask each trusted storage node over the LAN. The node
// is bound to this account, so the first reachable trusted node is sufficient.
// Mirrors the web `fetchNodeActivities`; never throws — returns an empty list
// when no node answers so the caller keeps the locally-cached feed.

import type { ActivityRecord } from "@repo/protocol";
import { NodeClient, nodusBaseUrl } from "@repo/relay-client/local-discovery";
import {
  identityPrivateKey,
  signDeviceMessage,
  type StoredDeviceIdentity,
} from "@repo/relay-client/device-identity";

import { getTrustedNodes } from "../store/trusted-nodes";

export async function loadNodeActivities(
  device: StoredDeviceIdentity,
  limit = 200,
): Promise<ActivityRecord[]> {
  const nodes = await getTrustedNodes();
  for (const node of nodes) {
    try {
      return await new NodeClient(nodusBaseUrl(node.host)).listActivities(
        device.device_id,
        (message) => signDeviceMessage(identityPrivateKey(device), message),
        limit,
      );
    } catch {
      // Unreachable or rejected; try the next trusted host.
    }
  }
  return [];
}
