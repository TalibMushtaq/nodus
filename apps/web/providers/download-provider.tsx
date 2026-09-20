"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "@repo/ui/primitives/icons";
import { PathIndicator } from "@repo/ui/primitives/path-indicator";
import type { TransferPath } from "@repo/ui/primitives/path-indicator";
import type { DownloadProgressEvent, DownloadPhase, DownloadTransport } from "@repo/sdk";

import { DownloadShards } from "../components/download-shards";
import { downloadMetrics } from "../lib/download-metrics";
import { formatBytes, formatCountdown } from "../lib/format";

// Download queue state lives here (not in FilesClient) so the floating widget
// survives route changes: navigating away from Files unmounts that page while
// the download's async loop keeps running. The provider owns the queue and
// renders the widget itself, mirroring UploadProvider.

export type DownloadStatus = "active" | "done" | "error" | "cancelled";

/**
 * Map the transport the SDK actually used onto the shared transfer-path
 * vocabulary the PathIndicator renders. Downloads are LAN-direct by default,
 * the Relay proxy when the node is unreachable, and (once the node can serve
 * shards over a data channel) WebRTC — which is a direct P2P hop, so it reads
 * as "local".
 */
export const TRANSPORT_PATH: Record<DownloadTransport, TransferPath> = {
  lan: "local",
  relay: "buffered",
  webrtc: "local",
};

export interface DownloadTask {
  id: string;
  name: string;
  phase: DownloadPhase;
  completedShards: number;
  totalShards: number;
  completedBytes: number;
  totalBytes: number;
  status: DownloadStatus;
  /** Epoch-ms the download started; the basis for average throughput/ETA. */
  startedAt: number;
  /** Transport that served the most recent shard, when known. */
  transport?: DownloadTransport;
  /** True once the caller registered a retry runner for this task. */
  retryable?: boolean;
  error?: string;
}

export { downloadMetrics } from "../lib/download-metrics";

/**
 * Stage labels. "Decrypting" is called out explicitly because the AEAD open is
 * CPU-bound and, on a large version, is a visible pause after the bytes land —
 * "Downloading" alone made that look like a hang.
 */
export const PHASE_LABEL: Record<DownloadPhase, string> = {
  unlocking: "Unlocking key",
  fetching: "Downloading",
  verifying: "Verifying",
  decrypting: "Decrypting",
  assembling: "Assembling",
  done: "Downloaded",
};

const STATUS_COLOR: Record<DownloadStatus, string> = {
  active: "var(--status-pending)",
  done: "var(--status-synced)",
  error: "var(--status-conflict)",
  cancelled: "var(--status-offline)",
};

interface DownloadContextValue {
  tasks: DownloadTask[];
  /**
   * Register a download and return its task id plus the signal the transfer
   * loop must pass to `downloadFile`, so cancel aborts the in-flight fetch.
   */
  startDownload: (input: { name: string }) => { id: string; signal: AbortSignal };
  reportProgress: (id: string, event: DownloadProgressEvent) => void;
  /** Record which transport served the latest shard (LAN/Relay/WebRTC). */
  reportTransport: (id: string, transport: DownloadTransport) => void;
  finishDownload: (id: string, outcome: "done" | "error", error?: string) => void;
  /** Abort an active download; the transfer loop rejects with CancelledError. */
  cancelDownload: (id: string) => void;
  /**
   * Register how to re-run a task. The Files page owns the download mechanics,
   * so the provider only carries this opaque runner; it is invoked with a fresh
   * signal when the user retries.
   */
  registerDownloadRetry: (id: string, run: (signal: AbortSignal) => void) => void;
  /** Re-run a failed/cancelled task with a new signal, resetting its state. */
  retryDownload: (id: string) => void;
  dismiss: () => void;
}

const DownloadContext = createContext<DownloadContextValue | null>(null);

export function DownloadProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  // One abort controller per active task. Kept in a ref (not state) because
  // aborting must not trigger a render on its own — the task's status does.
  const controllersRef = useRef(new Map<string, AbortController>());
  // How to re-run each task, supplied by whoever started it (Files). Kept out
  // of task state because functions are not render-serializable.
  const retryRunnersRef = useRef(new Map<string, (signal: AbortSignal) => void>());

  const startDownload = useCallback((input: { name: string }) => {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    controllersRef.current.set(id, controller);
    setTasks((previous) => [
      ...previous,
      {
        id,
        name: input.name,
        phase: "unlocking",
        completedShards: 0,
        totalShards: 0,
        completedBytes: 0,
        totalBytes: 0,
        status: "active",
        startedAt: Date.now(),
      },
    ]);
    return { id, signal: controller.signal };
  }, []);

  const reportProgress = useCallback((id: string, event: DownloadProgressEvent) => {
    setTasks((previous) =>
      previous.map((task) =>
        task.id === id
          ? {
              ...task,
              phase: event.phase,
              completedShards: event.completedShards,
              totalShards: event.totalShards,
              completedBytes: event.completedBytes,
              totalBytes: event.totalBytes,
              status: event.phase === "done" ? "done" : "active",
            }
          : task,
      ),
    );
  }, []);

  const reportTransport = useCallback((id: string, transport: DownloadTransport) => {
    // Only the newest transport matters for the label: a transient LAN miss that
    // fell back to the Relay should not leave the chip claiming "Local P2P".
    setTasks((previous) =>
      previous.map((task) => (task.id === id ? { ...task, transport } : task)),
    );
  }, []);

  const finishDownload = useCallback(
    (id: string, outcome: "done" | "error", error?: string) => {
      controllersRef.current.delete(id);
      setTasks((previous) =>
        previous.map((task) =>
          task.id === id ? { ...task, status: outcome, error, phase: "done" } : task,
        ),
      );
    },
    [],
  );

  const cancelDownload = useCallback((id: string) => {
    const controller = controllersRef.current.get(id);
    controllersRef.current.delete(id);
    controller?.abort();
    // Mark it cancelled immediately so the UI stops spinning; the transfer
    // loop's rejection is handled by the caller (which sees the abort).
    setTasks((previous) =>
      previous.map((task) => (task.id === id ? { ...task, status: "cancelled", error: undefined } : task)),
    );
  }, []);

  const registerDownloadRetry = useCallback((id: string, run: (signal: AbortSignal) => void) => {
    retryRunnersRef.current.set(id, run);
    setTasks((previous) =>
      previous.map((task) => (task.id === id ? { ...task, retryable: true } : task)),
    );
  }, []);

  const retryDownload = useCallback((id: string) => {
    const run = retryRunnersRef.current.get(id);
    if (!run) return;
    // A retry is a fresh attempt: abort any lingering transfer, mint a new
    // signal, and reset the visible state before the runner reports progress.
    controllersRef.current.get(id)?.abort();
    const controller = new AbortController();
    controllersRef.current.set(id, controller);
    setTasks((previous) =>
      previous.map((task) =>
        task.id === id
          ? {
              ...task,
              phase: "unlocking",
              completedShards: 0,
              completedBytes: 0,
              totalBytes: 0,
              status: "active",
              transport: undefined,
              error: undefined,
              startedAt: Date.now(),
            }
          : task,
      ),
    );
    run(controller.signal);
  }, []);

  const dismiss = useCallback(() => {
    // Clear the list only after every in-flight transfer has been aborted, so a
    // dismissed widget cannot leave a fetch running headless.
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
    retryRunnersRef.current.clear();
    setTasks([]);
  }, []);

  const value = useMemo<DownloadContextValue>(
    () => ({
      tasks,
      startDownload,
      reportProgress,
      reportTransport,
      finishDownload,
      cancelDownload,
      registerDownloadRetry,
      retryDownload,
      dismiss,
    }),
    [
      tasks,
      startDownload,
      reportProgress,
      reportTransport,
      finishDownload,
      cancelDownload,
      registerDownloadRetry,
      retryDownload,
      dismiss,
    ],
  );

  return (
    <DownloadContext.Provider value={value}>
      {children}
      <DownloadWidget
        tasks={tasks}
        onDismiss={dismiss}
        onCancel={cancelDownload}
        onRetry={retryDownload}
      />
    </DownloadContext.Provider>
  );
}

export function useDownload(): DownloadContextValue {
  const ctx = useContext(DownloadContext);
  if (!ctx) throw new Error("useDownload must be used within a DownloadProvider");
  return ctx;
}

/**
 * Floating progress card pinned bottom-centre (the upload queue owns the
 * bottom-right corner, so the two never overlap). Shows the current stage —
 * Downloading, Verifying, Decrypting — plus byte/shard progress per file, and
 * auto-dismisses once every task finishes without errors.
 */
function DownloadWidget({
  tasks,
  onDismiss,
  onCancel,
  onRetry,
}: {
  tasks: DownloadTask[];
  onDismiss: () => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const activeCount = tasks.filter((task) => task.status === "active").length;
  const errorCount = tasks.filter((task) => task.status === "error").length;
  const doneCount = tasks.filter((task) => task.status === "done").length;
  const cancelledCount = tasks.filter((task) => task.status === "cancelled").length;
  const allDone = tasks.length > 0 && activeCount === 0;

  useEffect(() => {
    if (!allDone || errorCount > 0) return;
    const timer = setTimeout(onDismiss, 4500);
    return () => clearTimeout(timer);
  }, [allDone, errorCount, onDismiss]);

  // The SDK reports bytes once per shard, so without a ticker the speed/ETA
  // readout would sit frozen between shard arrivals. Re-rendering each second
  // recomputes the average against the wall clock.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (activeCount === 0) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [activeCount]);

  if (tasks.length === 0) return null;

  const heading =
    activeCount > 0
      ? `Downloading ${activeCount} file${activeCount === 1 ? "" : "s"}`
      : errorCount > 0
        ? `${errorCount} download${errorCount === 1 ? "" : "s"} failed`
        : doneCount > 0
          ? `Downloaded ${doneCount} file${doneCount === 1 ? "" : "s"}`
          : `Cancelled ${cancelledCount} download${cancelledCount === 1 ? "" : "s"}`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-50 w-[24rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl border border-border bg-card shadow-lg overflow-hidden"
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/50"
      >
        <span className="flex items-center gap-2 min-w-0">
          <Icon
            name={errorCount > 0 ? "warning" : activeCount > 0 ? "download" : "check"}
            size={16}
            className={activeCount > 0 ? "text-foreground animate-pulse" : "text-foreground"}
          />
          <span className="text-xs font-medium text-foreground truncate">{heading}</span>
        </span>
        <Icon
          name="chevron-down"
          size={14}
          className={collapsed ? "text-muted-foreground" : "rotate-180 text-muted-foreground"}
        />
      </button>

      {!collapsed && (
        <div className="border-t border-border max-h-72 overflow-y-auto">
          {tasks.map((task) => {
            const label =
              task.status === "error"
                ? "Failed"
                : task.status === "cancelled"
                  ? "Cancelled"
                  : task.status === "done"
                    ? "Downloaded"
                    : PHASE_LABEL[task.phase];
            const { speedBps, etaSeconds } = downloadMetrics(task);
            return (
              <div key={task.id} className="px-4 py-2.5 border-b border-border last:border-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-foreground truncate" title={task.name}>
                    {task.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-[10px]" style={{ color: STATUS_COLOR[task.status] }}>
                      {label}
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
                    {task.retryable && (task.status === "error" || task.status === "cancelled") ? (
                      <button
                        type="button"
                        onClick={() => onRetry(task.id)}
                        aria-label={`Retry ${task.name}`}
                        title="Retry download"
                        className="text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <Icon name="refresh" size={12} />
                      </button>
                    ) : null}
                  </span>
                </div>
                <div className="mt-1.5">
                  <DownloadShards
                    completed={task.completedShards}
                    total={task.totalShards}
                    status={task.status}
                  />
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
                  <span>
                    {task.totalBytes > 0
                      ? `${formatBytes(task.completedBytes)} / ${formatBytes(task.totalBytes)}`
                      : `${task.completedShards} / ${task.totalShards} shards`}
                  </span>
                  {task.status === "active" && speedBps > 0 ? (
                    <span>{formatBytes(speedBps)}/s</span>
                  ) : null}
                  {task.status === "active" && etaSeconds != null ? (
                    <span>ETA {formatCountdown(etaSeconds)}</span>
                  ) : null}
                  {task.transport && task.status !== "error" ? (
                    <span className="ml-auto">
                      <PathIndicator path={TRANSPORT_PATH[task.transport]} />
                    </span>
                  ) : null}
                  {task.error ? ` · ${task.error}` : ""}
                </div>
              </div>
            );
          })}
          {allDone && errorCount === 0 && (
            <div className="flex items-center justify-between px-4 py-1.5 border-t border-border">
              <span className="text-[10px] text-muted-foreground">All downloads finished</span>
              <button
                type="button"
                onClick={onDismiss}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
