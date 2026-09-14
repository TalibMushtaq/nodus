"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { StatCard } from "@repo/ui/primitives/stat-card";
import { Section } from "@repo/ui/primitives/section";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { Button } from "@repo/ui/primitives/button";
import { StatusBadge, type SyncStatus } from "@repo/ui/primitives/badge";
import { PathIndicator } from "@repo/ui/primitives/path-indicator";
import { Icon, type IconName } from "@repo/ui/primitives/icons";

import {
  listNodes,
  listDevices,
  isNodeOnline,
  type RelayNode,
  type RelayDevice,
} from "../../../lib/pairing";
import { isRelayOnline, relayStatusLabel } from "../../../lib/connectivity";
import { useFiles } from "../../../lib/use-files";
import { useTransfer } from "../../../providers/transfer-provider";
import { useWs } from "../../../providers/ws-provider";
import { useAuth } from "../../../providers/auth-provider";
import { listTransfers, type TransferLogEntry } from "../../../lib/transfer-log";
import { listTombstones, type TombstoneItem } from "../../../lib/tombstones";
import { formatBytes, shortId, timeAgo } from "../../../lib/format";
import type { FileStorageState } from "../../../lib/file-view";
import {
  activityLabel,
  isDeviceOnline,
  onlineCounts,
  pendingShardCount,
  recentActivity,
  recentFiles,
  storageUsage,
  tombstoneWindow,
} from "../../../lib/overview";

// Overview is a "single pane of glass" over the account: network topology, the
// four headline figures, the newest files and activity, and a device strip.
// Every figure is derived from a real source (Relay catalog + node heartbeats,
// the local transfer log, and the tombstone list); nothing is mocked.

interface OverviewClientProps {
  /** Operator-configured public Relay address, resolved server-side. */
  publicRelayUrl: string | null;
}

const STORAGE_TO_STATUS: Record<FileStorageState, SyncStatus> = {
  node: "synced",
  relay: "pending",
  transferring: "pending",
  local: "local-only",
  conflict: "conflict",
};

/** Where a file's latest version lives, phrased for the recent-files row. */
const STORAGE_LOCATION: Record<FileStorageState, string> = {
  node: "On node",
  relay: "Relay buffer",
  transferring: "Transferring",
  local: "This device",
  conflict: "Conflict",
};

/** CSS status-token suffix for the row's accent bar (states share tokens). */
function statusToken(state: FileStorageState): string {
  switch (state) {
    case "node":
      return "synced";
    case "relay":
    case "transferring":
      return "pending";
    case "conflict":
      return "conflict";
    default:
      return "local";
  }
}

/** One box in the topology diagram. */
function TopologyNode({
  icon,
  label,
  detail,
  active,
  muted,
}: {
  icon: IconName;
  label: string;
  detail: string;
  active: boolean;
  muted?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center gap-1 min-w-[84px] ${muted ? "opacity-70" : ""}`}>
      <div
        className="w-12 h-12 border-2 rounded-sm flex items-center justify-center bg-secondary"
        style={{ borderColor: active ? "var(--color-accent)" : "var(--color-border)" }}
      >
        <span style={{ color: active ? "var(--color-accent)" : "var(--color-muted-foreground)" }}>
          <Icon name={icon} size={20} />
        </span>
      </div>
      <span className="text-[10px] text-muted-foreground font-mono text-center leading-tight">
        {label}
        <br />
        {detail}
      </span>
    </div>
  );
}

/** Connector between two topology boxes with a path caption. */
function TopologyLink({ caption, solid }: { caption: string; solid?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center mx-2 min-w-[64px]">
      <div className={solid ? "w-12 border-t border-accent/60" : "w-12 border-t border-dashed border-border"} />
      <span className="text-[9px] text-muted-foreground font-mono mt-0.5 whitespace-nowrap">{caption}</span>
    </div>
  );
}

export function OverviewClient({ publicRelayUrl }: OverviewClientProps) {
  const router = useRouter();
  const { session } = useAuth();
  const { status: wsStatus } = useWs();
  const { files } = useFiles();
  const { queuedCount } = useTransfer();

  const [nodes, setNodes] = useState<RelayNode[]>([]);
  const [devices, setDevices] = useState<RelayDevice[]>([]);
  const [activity, setActivity] = useState<TransferLogEntry[]>([]);
  const [tombstones, setTombstones] = useState<TombstoneItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Relay catalog (required) and the local activity log / tombstone list
  // (best-effort: a Relay hiccup must not blank the whole dashboard, and the
  // local log is always available even when offline).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [n, d] = await Promise.all([listNodes(), listDevices()]);
        if (cancelled) return;
        setNodes(n);
        setDevices(d);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
      const [log, trash] = await Promise.allSettled([listTransfers(), listTombstones()]);
      if (cancelled) return;
      if (log.status === "fulfilled") setActivity(log.value);
      if (trash.status === "fulfilled") setTombstones(trash.value);
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // Keep presence-derived cards fresh on the same cadence as the Devices page,
  // so a node that stops heartbeating falls to offline without a manual reload.
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(() => {
      void Promise.all([listNodes(), listDevices()])
        .then(([n, d]) => {
          if (cancelled) return;
          setNodes(n);
          setDevices(d);
        })
        .catch(() => {
          // transient blip; the next tick retries
        });
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    setReloadToken((token) => token + 1);
  }, []);

  const usage = useMemo(() => storageUsage(nodes), [nodes]);
  const counts = useMemo(() => onlineCounts(nodes, devices), [nodes, devices]);
  const pending = useMemo(() => pendingShardCount(files, queuedCount), [files, queuedCount]);
  const retention = useMemo(() => tombstoneWindow(tombstones), [tombstones]);
  const files4 = useMemo(() => recentFiles(files, 4), [files]);
  const activity4 = useMemo(() => recentActivity(activity, 4), [activity]);

  const relayOnline = isRelayOnline(wsStatus);
  const primaryNode = nodes.find((n) => n.is_primary) ?? nodes[0] ?? null;
  // The topology contrasts "this browser" with another client (the design shows
  // a desktop + a phone); pick the first device that is not this browser.
  const peerDevice =
    devices.find((d) => d.device_id !== session?.device_id && d.status !== "REVOKED") ?? null;

  const deviceCards = useMemo(() => {
    const nodeCards = nodes.map((n) => ({
      key: n.node_id,
      type: "Storage node",
      name: n.display_name ?? shortId(n.node_id),
      status: (isNodeOnline(n) ? "synced" : "offline") as SyncStatus,
      detail:
        (n.total_bytes ?? 0) > 0
          ? `${formatBytes(n.used_bytes ?? 0)} / ${formatBytes(n.total_bytes)}`
          : "Capacity unknown",
    }));
    const deviceCards = devices.map((d) => ({
      key: d.device_id,
      type: "Client",
      name: d.display_name ?? shortId(d.device_id),
      status: (d.status === "REVOKED" ? "offline" : isDeviceOnline(d) ? "synced" : "pending") as SyncStatus,
      detail: d.revoked_at
        ? `Revoked ${timeAgo(d.revoked_at)}`
        : d.last_seen_at
          ? `Active ${timeAgo(d.last_seen_at)}`
          : "Not seen",
    }));
    return [...nodeCards, ...deviceCards].slice(0, 4);
  }, [nodes, devices]);

  const nothingConnected = !loading && nodes.length === 0 && devices.length === 0;

  return (
    <div className="max-w-6xl space-y-6 p-6">
      {error && (
        <div className="flex items-center gap-3" role="alert">
          <p className="text-xs text-destructive">{error}</p>
          <Button variant="secondary" size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      )}

      {/* Network topology */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Network topology
          </h2>
          <button
            type="button"
            onClick={retry}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Refresh
          </button>
        </div>
        <div className="bg-gradient-to-br from-orange-50/60 to-amber-50/40 border border-border rounded-xl p-5 dark:from-amber-950/20 dark:to-orange-950/10">
          <div className="flex items-center justify-center gap-0 overflow-x-auto">
            <TopologyNode icon="devices" label="Web client" detail="This browser" active />
            <TopologyLink caption="Local P2P" solid />
            <TopologyNode
              icon="server"
              label="Storage Node"
              detail={primaryNode ? primaryNode.display_name ?? shortId(primaryNode.node_id) : "none"}
              active={primaryNode ? isNodeOnline(primaryNode) : false}
            />
            <TopologyLink caption="Relay ↑" />
            <TopologyNode
              icon="activity"
              label="Go Relay"
              detail={relayOnline ? "Connected" : relayStatusLabel(wsStatus)}
              active={relayOnline}
            />
            <TopologyLink caption="Relay ↓" />
            <TopologyNode
              icon="phone"
              label="Client"
              detail={peerDevice ? peerDevice.display_name ?? shortId(peerDevice.device_id) : "none"}
              active={peerDevice ? isDeviceOnline(peerDevice) : false}
              muted={!peerDevice}
            />
          </div>
          {publicRelayUrl && (
            <p className="text-[10px] text-muted-foreground font-mono text-center mt-3 truncate">
              {publicRelayUrl}
            </p>
          )}
        </div>
      </section>

      {/* Stat cards */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Storage used"
          value={loading ? "…" : formatBytes(usage.usedBytes)}
          sub={
            usage.capacityKnown
              ? `of ${formatBytes(usage.totalBytes)}`
              : nodes.length > 0
                ? `across ${nodes.length} node${nodes.length === 1 ? "" : "s"}`
                : "no nodes paired"
          }
          link="Manage →"
          color="var(--status-pending)"
          onClick={() => router.push("/devices")}
        />
        <StatCard
          label="Devices online"
          value={loading ? "…" : String(counts.nodesOnline + counts.devicesOnline)}
          sub={`of ${counts.nodesTotal + counts.devicesTotal} paired`}
          link="View →"
          color="var(--status-synced)"
          onClick={() => router.push("/devices")}
        />
        <StatCard
          label="Pending shards"
          value={loading ? "…" : String(pending)}
          sub={pending > 0 ? "uploading" : "all backed up"}
          link="Activity →"
          color="var(--status-local)"
          onClick={() => router.push("/activity")}
        />
        <StatCard
          label="Tombstone window"
          value={loading ? "…" : String(retention.daysRemaining ?? retention.windowDays)}
          sub={
            retention.daysRemaining === null
              ? `${retention.windowDays}-day window · empty`
              : `of ${retention.windowDays} days remaining`
          }
          link="Settings →"
          color="var(--status-conflict)"
          onClick={() => router.push("/settings")}
        />
      </section>

      {nothingConnected && (
        <Section title="Getting started">
          <EmptyState
            title="Nothing connected yet"
            description="Pair a Storage Node to start syncing files across your network."
          />
        </Section>
      )}

      {/* Bottom grid: recent files + recent activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Recent files"
          action={
            <button
              type="button"
              onClick={() => router.push("/files")}
              className="text-xs text-accent hover:opacity-80 transition-opacity"
            >
              View all
            </button>
          }
        >
          {files4.length === 0 ? (
            <EmptyState
              title={loading ? "Loading files…" : "No files yet"}
              description={loading ? "Reading the local catalog." : "Upload a file to see it here."}
            />
          ) : (
            <div className="bg-card border border-border divide-y divide-border rounded-xl overflow-hidden">
              {files4.map((file) => (
                <button
                  key={file.fileId}
                  type="button"
                  onClick={() => router.push("/files")}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-secondary/50 transition-colors"
                >
                  <div
                    className="w-1 h-9 rounded-full shrink-0"
                    style={{ backgroundColor: `var(--status-${statusToken(file.storageState)})` }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-foreground truncate">{file.name}</div>
                    <div className="text-[10px] text-muted-foreground font-mono truncate">
                      {file.sizeBytes != null ? formatBytes(file.sizeBytes) : "—"} ·{" "}
                      {STORAGE_LOCATION[file.storageState]}
                    </div>
                  </div>
                  <StatusBadge status={STORAGE_TO_STATUS[file.storageState]} variant="dot" />
                  <div className="text-[10px] text-muted-foreground font-mono shrink-0">
                    {timeAgo(file.updatedAt)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Recent activity"
          action={
            <button
              type="button"
              onClick={() => router.push("/activity")}
              className="text-xs text-accent hover:opacity-80 transition-opacity"
            >
              View all
            </button>
          }
        >
          {activity4.length === 0 ? (
            <EmptyState
              title={loading ? "Loading activity…" : "No activity yet"}
              description={
                loading
                  ? "Reading this device's transfer log."
                  : "Uploads and downloads from this browser will show up here."
              }
            />
          ) : (
            <div className="bg-card border border-border divide-y divide-border rounded-xl overflow-hidden">
              {activity4.map((entry) => (
                <div key={entry.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/50 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-foreground truncate">
                      <span className="text-muted-foreground text-xs">{activityLabel(entry)}</span>{" "}
                      {entry.fileName}
                    </div>
                    <div className="text-[10px] text-muted-foreground font-mono truncate">
                      {entry.detail ?? "this device"}
                    </div>
                  </div>
                  {entry.path && <PathIndicator path={entry.path} />}
                  <div className="text-[10px] text-muted-foreground font-mono shrink-0">
                    {timeAgo(entry.at)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      {/* Devices mini-panel */}
      <Section
        title="Devices"
        action={
          <button
            type="button"
            onClick={() => router.push("/devices")}
            className="text-xs text-accent hover:opacity-80 transition-opacity"
          >
            Manage devices
          </button>
        }
      >
        {deviceCards.length === 0 ? (
          <EmptyState
            title={loading ? "Loading devices…" : "No devices yet"}
            description={loading ? "Reading the Relay catalog." : "Pair a device or node to see it here."}
          />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {deviceCards.map((device) => (
              <div key={device.key} className="bg-card border border-border rounded-xl p-3 flex flex-col gap-2">
                <div className="flex items-start justify-between">
                  <span className="text-[10px] font-medium text-muted-foreground">{device.type}</span>
                  <StatusBadge status={device.status} variant="dot" />
                </div>
                <div className="text-sm font-medium text-foreground truncate">{device.name}</div>
                <div className="text-[10px] text-muted-foreground font-mono truncate">{device.detail}</div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
