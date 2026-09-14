// Pure selectors for the Security page. Kept free of React/IndexedDB so the
// derived table rows can be unit tested directly, matching file-view/overview.

import type { RelayNode, RelayDevice } from "./pairing";
import type { EnvelopeSummary } from "./envelopes";
import { shortId, timeAgo } from "./format";
import { isDeviceOnline } from "./overview";

/** One row of the Key envelopes table, with the recipient's display name resolved. */
export interface EnvelopeRow {
  /** Stable React key: `kind:recipient_id`. */
  key: string;
  /** Human label (device/node display name, or "Recovery key"). */
  name: string;
  /** Monospace id shown beneath the name. */
  id: string;
  fileCount: number;
  folderCount: number;
  /** ISO timestamp of the recipient's newest envelope, or null. */
  lastUpdated: string | null;
}

/**
 * Resolve envelope coverage to table rows by joining recipients against the
 * device/node catalogs. A recipient that no longer exists in the catalog is
 * still rendered (by short id) rather than dropped: its coverage is real and
 * its disappearance is itself worth surfacing.
 */
export function envelopeRows(
  summaries: EnvelopeSummary[],
  devices: RelayDevice[],
  nodes: RelayNode[],
): EnvelopeRow[] {
  const devicesById = new Map(devices.map((d) => [d.device_id, d]));
  const nodesById = new Map(nodes.map((n) => [n.node_id, n]));

  return summaries.map((summary) => {
    const key = `${summary.recipient_kind}:${summary.recipient_id}`;
    if (summary.recipient_kind === "recovery") {
      return {
        key,
        name: "Recovery key",
        id: shortId(summary.recipient_id),
        fileCount: summary.file_count,
        folderCount: summary.folder_count,
        lastUpdated: summary.last_updated,
      };
    }
    if (summary.recipient_kind === "node") {
      const node = nodesById.get(summary.recipient_id);
      return {
        key,
        name: node?.display_name ?? shortId(summary.recipient_id),
        id: summary.recipient_id,
        fileCount: summary.file_count,
        folderCount: summary.folder_count,
        lastUpdated: summary.last_updated,
      };
    }
    const device = devicesById.get(summary.recipient_id);
    return {
      key,
      name: device?.display_name ?? shortId(summary.recipient_id),
      id: summary.recipient_id,
      fileCount: summary.file_count,
      folderCount: summary.folder_count,
      lastUpdated: summary.last_updated,
    };
  });
}

/** Human label for a device's last-known activity, matching the design copy. */
export function deviceLastActive(device: RelayDevice, now: number = Date.now()): string {
  if (device.status === "REVOKED") {
    return device.revoked_at ? `Revoked ${timeAgo(device.revoked_at)}` : "Revoked";
  }
  if (isDeviceOnline(device, now)) return "Active now";
  return device.last_seen_at ? `Last active ${timeAgo(device.last_seen_at)}` : "Not seen";
}
