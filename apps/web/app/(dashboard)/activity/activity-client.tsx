"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Section } from "@repo/ui/primitives/section";
import { PageHeader } from "@repo/ui/primitives/page-header";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { Button } from "@repo/ui/primitives/button";
import { ConfirmDialog } from "@repo/ui/primitives/overlay";
import { Icon } from "@repo/ui/primitives/icons";
import { PathIndicator } from "@repo/ui/primitives/path-indicator";
import type { IconName } from "@repo/ui/primitives/icons";

import {
  listTransfers,
  clearTransfers,
  importRemoteActivities,
  type TransferKind,
  type TransferLogEntry,
  type TransferOutcome,
} from "../../../lib/transfer-log";
import { useAuth } from "../../../providers/auth-provider";
import { useFiles } from "../../../lib/use-files";
import { deviceLabel, fetchNodeActivities, fetchRelayActivities } from "../../../lib/activities";
import { listDevices, type RelayDevice } from "../../../lib/pairing";
import { describeDeviceInfo, shortId, timeAgo } from "../../../lib/format";

// Account-wide activity: durable on the Relay and storage nodes, so the feed is
// the same on every device and survives clearing browser data. Each entry shows
// which device performed it (its account name, else the auto-captured
// platform/browser). File names are E2E and resolve from the local catalog.

type ActivityFilter = "all" | TransferKind | "failed";

const FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "upload", label: "Uploads" },
  { value: "download", label: "Downloads" },
  { value: "delete", label: "Deletes" },
  { value: "restore", label: "Restores" },
  { value: "rename", label: "Renames" },
  { value: "failed", label: "Failed" },
];

const LABELS: Record<TransferKind, { complete: string; progress: string; failed: string }> = {
  upload: { complete: "Uploaded", progress: "Uploading", failed: "Upload failed" },
  download: { complete: "Downloaded", progress: "Downloading", failed: "Download failed" },
  delete: { complete: "Deleted", progress: "Deleting", failed: "Delete failed" },
  restore: { complete: "Restored", progress: "Restoring", failed: "Restore failed" },
  purge: { complete: "Permanently deleted", progress: "Deleting", failed: "Delete failed" },
  rename: { complete: "Renamed", progress: "Renaming", failed: "Rename failed" },
  move: { complete: "Moved", progress: "Moving", failed: "Move failed" },
  conflict: { complete: "Conflict resolved", progress: "Resolving", failed: "Conflict action failed" },
};

const ICONS: Record<TransferKind, IconName> = {
  upload: "upload",
  download: "download",
  delete: "trash",
  restore: "refresh",
  purge: "trash",
  rename: "files",
  move: "folder",
  conflict: "warning",
};

function eventLabel(entry: TransferLogEntry): string {
  const labels = LABELS[entry.kind] ?? LABELS.upload;
  if (entry.outcome === "failed") return labels.failed;
  if (entry.outcome === "in-progress") return labels.progress;
  return labels.complete;
}

function OutcomeChip({ outcome }: { outcome: TransferOutcome }) {
  if (outcome === "complete") {
    return <span className="text-[10px] font-mono" style={{ color: "var(--status-synced)" }}>Complete</span>;
  }
  if (outcome === "failed") {
    return <span className="text-[10px] font-mono" style={{ color: "var(--status-conflict)" }}>Failed</span>;
  }
  return (
    <span
      className="text-[10px] font-mono inline-flex items-center gap-1"
      style={{ color: "var(--status-pending)" }}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse inline-block" />
      In progress
    </span>
  );
}

export function ActivityClient() {
  const { device, signer } = useAuth();
  const { files } = useFiles();
  const [entries, setEntries] = useState<TransferLogEntry[]>([]);
  const [devices, setDevices] = useState<RelayDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Pull the account-wide feed (Relay online, else a trusted Node over the LAN).
  // Failures return null so the locally-cached feed is used unchanged.
  const fetchRemote = useCallback(async () => {
    if (!device || !signer) return null;
    try {
      return await fetchRelayActivities();
    } catch {
      // Offline: fall back to a paired node so the feed still works.
      try {
        return await fetchNodeActivities(device.device_id, (message) => signer.sign(message));
      } catch {
        return null;
      }
    }
  }, [device, signer]);

  // Merge the remote feed into the local store, then read the combined list.
  const load = useCallback(async () => {
    const remote = await fetchRemote();
    if (remote) await importRemoteActivities(remote);
    setEntries(await listTransfers());
    setLoading(false);
  }, [fetchRemote]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch populates state
    void load();
  }, [load]);

  useEffect(() => {
    // Device names/info label the feed; a failure just leaves ids.
    void listDevices()
      .then(setDevices)
      .catch(() => undefined);
  }, []);

  const fileNames = useMemo(
    () => new Map(files.map((file) => [file.fileId, file.name])),
    [files],
  );

  const visible = useMemo(() => {
    if (filter === "all") return entries;
    if (filter === "failed") return entries.filter((entry) => entry.outcome === "failed");
    return entries.filter((entry) => entry.kind === filter);
  }, [entries, filter]);

  const clear = useCallback(async () => {
    setClearing(true);
    try {
      await clearTransfers();
      setEntries([]);
      setConfirmClear(false);
    } finally {
      setClearing(false);
    }
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6">
      <PageHeader
        eyebrow="Timeline"
        title="Activity"
        description="Uploads, downloads, deletes, and restores across all your devices."
      />

      <Section
        title="Activity"
        action={
          entries.length > 0 ? (
            <Button variant="secondary" size="sm" onClick={() => setConfirmClear(true)}>
              Clear
            </Button>
          ) : undefined
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter activity">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilter(option.value)}
              aria-pressed={filter === option.value}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                filter === option.value
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-border text-muted-foreground hover:border-accent/30 hover:text-foreground"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-xs text-muted-foreground px-1">Loading activity…</p>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="activity"
            title={entries.length === 0 ? "No activity yet" : "Nothing matches this filter"}
            description={
              entries.length === 0
                ? "Uploads, downloads, deletes, and restores from any of your devices will show up here."
                : "Try a different filter."
            }
          />
        ) : (
          <div className="border border-border rounded-2xl overflow-hidden bg-card elev-card">
            {visible.map((entry) => {
              const displayName =
                entry.fileName || fileNames.get(entry.fileId) || (entry.fileId ? shortId(entry.fileId) : "");
              const label = deviceLabel(
                entry.deviceId ?? device?.device_id ?? "",
                devices,
                describeDeviceInfo,
                device?.device_id,
              );
              return (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 px-5 py-3.5 border-b border-border last:border-0"
                >
                  <span className="text-muted-foreground shrink-0">
                    <Icon name={ICONS[entry.kind] ?? "activity"} size={14} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-foreground truncate">
                      <span className="text-muted-foreground">{eventLabel(entry)}</span>
                      {displayName ? <> {displayName}</> : null}
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      <span className="text-foreground/80">{label}</span>
                      {entry.detail ? ` · ${entry.detail}` : ""}
                    </div>
                  </div>
                  {/* Path is only present for entries logged after transfer-path
                      capture shipped; older delete/restore rows have none. */}
                  {entry.path && <PathIndicator path={entry.path} />}
                  <OutcomeChip outcome={entry.outcome} />
                  <div className="text-[10px] font-mono text-muted-foreground shrink-0">{timeAgo(entry.at)}</div>
                </div>
              );
            })}
          </div>
        )}

        <p className="text-[10px] text-muted-foreground mt-3">
          Synced across your devices via the Relay and your storage nodes.
        </p>
      </Section>

      {confirmClear && (
        <ConfirmDialog
          title="Clear activity log"
          destructive
          busy={clearing}
          confirmLabel="Clear log"
          description="This hides the current history on this device. New activity still syncs across your account."
          onConfirm={() => void clear()}
          onClose={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}
