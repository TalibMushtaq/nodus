"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Section } from "@repo/ui/primitives/section";
import { PageHeader } from "@repo/ui/primitives/page-header";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { Icon } from "@repo/ui/primitives/icons";
import { PathIndicator } from "@repo/ui/primitives/path-indicator";
import type { TransferPath } from "@repo/ui/primitives/path-indicator";

import { DownloadShards } from "../../../components/download-shards";
import {
  PHASE_LABEL,
  TRANSPORT_PATH,
  downloadMetrics,
  useDownload,
  type DownloadTask,
} from "../../../providers/download-provider";
import {
  importRemoteActivities,
  listTransfers,
  type TransferLogEntry,
  type TransferOutcome,
} from "../../../lib/transfer-log";
import { fetchNodeActivities, fetchRelayActivities } from "../../../lib/activities";
import { useAuth } from "../../../providers/auth-provider";
import { useFiles } from "../../../lib/use-files";
import { formatBytes, formatCountdown, shortId, timeAgo } from "../../../lib/format";

// Downloads view. Two sources, deliberately kept distinct:
//  - Active: the in-memory DownloadProvider queue, which owns the live stage and
//    shard animation and survives route changes.
//  - History: the download slice of the durable transfer log, which is already
//    synced account-wide by ActivityProvider — so there is no second store.
// The page is a window onto the same data, not a new record of it, which is why
// "Clear history" lives on Activity and is intentionally not repeated here.

function outcomeColor(outcome: TransferOutcome): string {
  if (outcome === "complete") return "var(--status-synced)";
  if (outcome === "failed") return "var(--status-conflict)";
  return "var(--status-pending)";
}

function outcomeLabel(outcome: TransferOutcome): string {
  if (outcome === "complete") return "Downloaded";
  if (outcome === "failed") return "Failed";
  return "In progress";
}

function RetryableRow({ task, onRetry }: { task: DownloadTask; onRetry: (id: string) => void }) {
  const failed = task.status === "error";
  return (
    <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border last:border-0">
      <span className="text-muted-foreground shrink-0">
        <Icon name={failed ? "warning" : "close"} size={14} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-foreground truncate" title={task.name}>
          {task.name}
        </div>
        <div className="text-[10px] truncate" style={{ color: failed ? "var(--status-conflict)" : "var(--status-offline)" }}>
          {failed ? task.error || "Download failed" : "Cancelled"}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onRetry(task.id)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[10px] text-muted-foreground transition-colors hover:border-accent/40 hover:text-foreground"
      >
        <Icon name="refresh" size={11} />
        Retry
      </button>
    </div>
  );
}

function ActiveRow({ task, onCancel }: { task: DownloadTask; onCancel: (id: string) => void }) {
  // Bytes arrive once per shard, so tick each second to keep the average
  // throughput and ETA readout moving between shard completions.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const { speedBps, etaSeconds } = downloadMetrics(task);

  return (
    <div className="px-5 py-3.5 border-b border-border last:border-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground truncate" title={task.name}>
          {task.name}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-[10px]" style={{ color: outcomeColor(task.status === "error" ? "failed" : task.status === "done" ? "complete" : "in-progress") }}>
            {task.status === "error" ? "Failed" : task.status === "done" ? "Downloaded" : PHASE_LABEL[task.phase]}
          </span>
          {task.status === "active" ? (
            <button
              type="button"
              onClick={() => onCancel(task.id)}
              aria-label={`Cancel ${task.name}`}
              title="Cancel download"
              className="text-muted-foreground transition-colors hover:text-destructive"
            >
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </span>
      </div>
      <div className="mt-2">
        <DownloadShards completed={task.completedShards} total={task.totalShards} status={task.status} />
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
        <span>
          {task.totalBytes > 0
            ? `${formatBytes(task.completedBytes)} / ${formatBytes(task.totalBytes)}`
            : `${task.completedShards} / ${task.totalShards} shards`}
        </span>
        {task.status === "active" && speedBps > 0 ? <span>{formatBytes(speedBps)}/s</span> : null}
        {task.status === "active" && etaSeconds != null ? <span>ETA {formatCountdown(etaSeconds)}</span> : null}
        {task.transport && task.status !== "error" ? (
          <span className="ml-auto">
            <PathIndicator path={TRANSPORT_PATH[task.transport]} />
          </span>
        ) : null}
      </div>
      {task.error ? (
        <div className="mt-1 text-[10px] truncate" style={{ color: "var(--status-conflict)" }}>{task.error}</div>
      ) : null}
    </div>
  );
}

export function DownloadsClient() {
  const { device, signer } = useAuth();
  const { files } = useFiles();
  const { tasks, cancelDownload, retryDownload } = useDownload();
  const [history, setHistory] = useState<TransferLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const active = tasks.filter((task) => task.status === "active");
  // Failed/cancelled tasks the user can re-run. Kept separate from the durable
  // history below, which is a log and cannot retry.
  const retryable = tasks.filter(
    (task) => (task.status === "error" || task.status === "cancelled") && task.retryable,
  );

  // A stable signature of task lifecycle changes: reloading history on every
  // progress tick (many per second) would hammer IndexedDB for no reason, so we
  // only recompute when a task is added or reaches a terminal state.
  const taskSignature = useMemo(
    () => tasks.map((task) => `${task.id}:${task.status}`).join("|"),
    [tasks],
  );

  const fetchRemote = useCallback(async () => {
    if (!device || !signer) return null;
    try {
      return await fetchRelayActivities();
    } catch {
      try {
        return await fetchNodeActivities(device.device_id, (message) => signer.sign(message));
      } catch {
        return null;
      }
    }
  }, [device, signer]);

  const load = useCallback(async () => {
    const remote = await fetchRemote();
    if (remote) await importRemoteActivities(remote);
    const all = await listTransfers();
    setHistory(all.filter((entry) => entry.kind === "download"));
    setLoading(false);
  }, [fetchRemote]);

  // Runs on mount, when auth becomes available, and whenever a task changes
  // lifecycle (added / finished) — so a just-completed log entry appears without
  // a manual refresh, while progress ticks stay cheap.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch external stores (log + relay feed) into state
    void load();
  }, [taskSignature, load]);

  const fileNames = useMemo(
    () => new Map(files.map((file) => [file.fileId, file.name])),
    [files],
  );

  return (
    <div className="w-full space-y-8 p-6">
      <PageHeader
        eyebrow="Transfers"
        title="Downloads"
        description="Active and past downloads, with the transport each one used."
      />

      {retryable.length > 0 && (
        <Section title="Needs attention">
          <div className="border border-border rounded-2xl overflow-hidden bg-card elev-card">
            {retryable.map((task) => (
              <RetryableRow key={task.id} task={task} onRetry={retryDownload} />
            ))}
          </div>
        </Section>
      )}

      <Section title={active.length > 0 ? `Active (${active.length})` : "Active"}>
        {active.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">No downloads in progress.</p>
        ) : (
          <div className="border border-border rounded-2xl overflow-hidden bg-card elev-card">
            {active.map((task) => (
              <ActiveRow key={task.id} task={task} onCancel={cancelDownload} />
            ))}
          </div>
        )}
      </Section>

      <Section title="History">
        {loading ? (
          <p className="px-1 text-xs text-muted-foreground">Loading downloads…</p>
        ) : history.length === 0 ? (
          <EmptyState
            icon="download"
            title="No downloads yet"
            description="Files you download on this device — or any device on your account — will show up here."
          />
        ) : (
          <div className="border border-border rounded-2xl overflow-hidden bg-card elev-card">
            {history.map((entry) => {
              const displayName =
                entry.fileName || fileNames.get(entry.fileId) || (entry.fileId ? shortId(entry.fileId) : "File");
              return (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 px-5 py-3.5 border-b border-border last:border-0"
                >
                  <span className="text-muted-foreground shrink-0">
                    <Icon name="download" size={14} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-foreground truncate">
                      <span className="text-muted-foreground">{outcomeLabel(entry.outcome)}</span>{" "}
                      {displayName}
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {entry.detail || "Downloaded copy"}
                    </div>
                  </div>
                  {entry.path ? <PathIndicator path={entry.path as TransferPath} /> : null}
                  <span className="text-[10px] font-mono shrink-0" style={{ color: outcomeColor(entry.outcome) }}>
                    {entry.outcome === "in-progress" ? "Active" : entry.outcome === "failed" ? "Failed" : "Complete"}
                  </span>
                  <div className="text-[10px] font-mono text-muted-foreground shrink-0">{timeAgo(entry.at)}</div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
