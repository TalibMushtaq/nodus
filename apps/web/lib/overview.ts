// Pure selectors for the Overview page. Kept free of React/IndexedDB so the
// derived figures (storage, presence, pending shards, retention) can be unit
// tested directly, matching the file-view.ts convention.

import { isNodeOnline, type RelayNode, type RelayDevice } from "./pairing";
import type { FileEntryView } from "./file-view";
import type { ActivityPath, TransferLogEntry } from "./transfer-log";
import type { TombstoneItem } from "./tombstones";
import type { TransferPath } from "@repo/transfer-manager";

/**
 * How long after its last heartbeat a client device is still considered online.
 * Mirrors the node window in pairing.ts; the Relay throttles presence writes to
 * once a minute, so a device that just went quiet can read as online for a few
 * minutes. Intentionally generous to avoid flapping.
 */
export const DEVICE_ONLINE_WINDOW_MS = 2 * 60 * 1000;

/** True when a device heartbeated within `DEVICE_ONLINE_WINDOW_MS`. */
export function isDeviceOnline(device: RelayDevice, now: number = Date.now()): boolean {
  if (device.status === "REVOKED" || !device.last_seen_at) return false;
  const seen = new Date(device.last_seen_at).getTime();
  if (Number.isNaN(seen)) return false;
  return now - seen <= DEVICE_ONLINE_WINDOW_MS;
}

export interface StorageUsage {
  usedBytes: number;
  totalBytes: number;
  /** False when no node has reported capacity yet (pre-heartbeat / older node). */
  capacityKnown: boolean;
}

/**
 * Sum the disk figures nodes report in their heartbeats. `totalBytes` only
 * includes nodes that actually reported a capacity, so an old node cannot drag
 * the denominator to zero and make usage look infinite.
 */
export function storageUsage(nodes: RelayNode[]): StorageUsage {
  let usedBytes = 0;
  let totalBytes = 0;
  let capacityKnown = false;
  for (const node of nodes) {
    usedBytes += node.used_bytes ?? 0;
    const total = node.total_bytes ?? 0;
    if (total > 0) {
      totalBytes += total;
      capacityKnown = true;
    }
  }
  return { usedBytes, totalBytes, capacityKnown };
}

export interface OnlineCounts {
  nodesOnline: number;
  nodesTotal: number;
  devicesOnline: number;
  devicesTotal: number;
}

/** Online/offline roll-up for storage nodes and client devices. */
export function onlineCounts(
  nodes: RelayNode[],
  devices: RelayDevice[],
  now: number = Date.now(),
): OnlineCounts {
  return {
    nodesOnline: nodes.filter((n) => isNodeOnline(n, now)).length,
    nodesTotal: nodes.length,
    devicesOnline: devices.filter((d) => isDeviceOnline(d, now)).length,
    devicesTotal: devices.length,
  };
}

/**
 * Shards of each file's latest version that are not yet durably on a node, plus
 * shards queued locally (Path D) which never appear in the catalog. Buffered,
 * uploading, and node-receiving statuses all count as pending.
 */
export function pendingShardCount(files: FileEntryView[], queuedCount: number): number {
  let pending = 0;
  for (const file of files) {
    if (file.latestVersionNumber == null) continue;
    for (const location of file.locations) {
      if (location.version_number !== file.latestVersionNumber) continue;
      if (location.status !== "NODE_STORED") pending += 1;
    }
  }
  return pending + queuedCount;
}

/** Default tombstone retention window, matching the Relay's prune policy. */
export const TOMBSTONE_WINDOW_DAYS = 90;

export interface TombstoneWindow {
  /** Fewest days remaining before the soonest tombstone is purged, or null. */
  daysRemaining: number | null;
  windowDays: number;
}

/**
 * Days until the soonest tombstone purge. `purge_after` is stamped by the Relay
 * at delete time, so this is a countdown, not the configured retention.
 */
export function tombstoneWindow(
  tombstones: TombstoneItem[],
  now: number = Date.now(),
): TombstoneWindow {
  const windowDays = TOMBSTONE_WINDOW_DAYS;
  let minMs: number | null = null;
  for (const item of tombstones) {
    const purgeAt = new Date(item.purge_after).getTime();
    if (Number.isNaN(purgeAt)) continue;
    const remaining = purgeAt - now;
    if (minMs === null || remaining < minMs) minMs = remaining;
  }
  if (minMs === null) return { daysRemaining: null, windowDays };
  return { daysRemaining: Math.max(0, Math.ceil(minMs / (24 * 60 * 60 * 1000))), windowDays };
}

/** Newest-updated files first. */
export function recentFiles(files: FileEntryView[], count = 4): FileEntryView[] {
  return [...files].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, count);
}

/** The transfer log is already newest-first; this only trims it. */
export function recentActivity(entries: TransferLogEntry[], count = 4): TransferLogEntry[] {
  return entries.slice(0, count);
}

const ACTIVITY_LABELS: Record<
  TransferLogEntry["kind"],
  { complete: string; progress: string; failed: string }
> = {
  upload: { complete: "Uploaded", progress: "Uploading", failed: "Upload failed" },
  download: { complete: "Downloaded", progress: "Downloading", failed: "Download failed" },
  delete: { complete: "Deleted", progress: "Deleting", failed: "Delete failed" },
  restore: { complete: "Restored", progress: "Restoring", failed: "Restore failed" },
};

/** Past-tense verb for an activity row's outcome (e.g. "Uploaded"). */
export function activityLabel(entry: TransferLogEntry): string {
  const labels = ACTIVITY_LABELS[entry.kind];
  if (entry.outcome === "failed") return labels.failed;
  if (entry.outcome === "in-progress") return labels.progress;
  return labels.complete;
}

/**
 * Translate the transfer-manager's internal path to the UI's PathIndicator
 * vocabulary. `local_queue` (Path D) is "queued", not "buffered": the bytes sit
 * in this device's persistent queue and have not reached the Relay buffer at
 * all. Collapsing the two made Activity claim a file was Relay-buffered while
 * the Files table (correctly) showed it as local-only.
 */
export function activityPathFromTransfer(path: TransferPath | undefined): ActivityPath | undefined {
  switch (path) {
    case "local_signaling":
      return "local";
    case "relay_signaling":
      return "relay";
    case "buffer_relay":
      return "buffered";
    case "local_queue":
      return "queued";
    default:
      return undefined;
  }
}
