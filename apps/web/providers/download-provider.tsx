"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "@repo/ui/primitives/icons";
import { Progress } from "@repo/ui/primitives/progress";
import type { DownloadProgressEvent, DownloadPhase } from "@repo/sdk";

import { formatBytes } from "../lib/format";

// Download queue state lives here (not in FilesClient) so the floating widget
// survives route changes: navigating away from Files unmounts that page while
// the download's async loop keeps running. The provider owns the queue and
// renders the widget itself, mirroring UploadProvider.

export type DownloadStatus = "active" | "done" | "error";

export interface DownloadTask {
  id: string;
  name: string;
  phase: DownloadPhase;
  completedShards: number;
  totalShards: number;
  completedBytes: number;
  totalBytes: number;
  status: DownloadStatus;
  error?: string;
}

/**
 * Stage labels. "Decrypting" is called out explicitly because the AEAD open is
 * CPU-bound and, on a large version, is a visible pause after the bytes land —
 * "Downloading" alone made that look like a hang.
 */
const PHASE_LABEL: Record<DownloadPhase, string> = {
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
};

interface DownloadContextValue {
  tasks: DownloadTask[];
  /** Register a download and return its task id for progress reporting. */
  startDownload: (input: { name: string }) => string;
  reportProgress: (id: string, event: DownloadProgressEvent) => void;
  finishDownload: (id: string, outcome: "done" | "error", error?: string) => void;
  dismiss: () => void;
}

const DownloadContext = createContext<DownloadContextValue | null>(null);

export function DownloadProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);

  const startDownload = useCallback((input: { name: string }) => {
    const id = crypto.randomUUID();
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
      },
    ]);
    return id;
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

  const finishDownload = useCallback(
    (id: string, outcome: "done" | "error", error?: string) => {
      setTasks((previous) =>
        previous.map((task) =>
          task.id === id ? { ...task, status: outcome, error, phase: "done" } : task,
        ),
      );
    },
    [],
  );

  const dismiss = useCallback(() => setTasks([]), []);

  const value = useMemo<DownloadContextValue>(
    () => ({ tasks, startDownload, reportProgress, finishDownload, dismiss }),
    [tasks, startDownload, reportProgress, finishDownload, dismiss],
  );

  return (
    <DownloadContext.Provider value={value}>
      {children}
      <DownloadWidget tasks={tasks} onDismiss={dismiss} />
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
}: {
  tasks: DownloadTask[];
  onDismiss: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const activeCount = tasks.filter((task) => task.status === "active").length;
  const errorCount = tasks.filter((task) => task.status === "error").length;
  const doneCount = tasks.filter((task) => task.status === "done").length;
  const allDone = tasks.length > 0 && activeCount === 0;

  useEffect(() => {
    if (!allDone || errorCount > 0) return;
    const timer = setTimeout(onDismiss, 4500);
    return () => clearTimeout(timer);
  }, [allDone, errorCount, onDismiss]);

  if (tasks.length === 0) return null;

  const heading =
    activeCount > 0
      ? `Downloading ${activeCount} file${activeCount === 1 ? "" : "s"}`
      : errorCount > 0
        ? `${errorCount} download${errorCount === 1 ? "" : "s"} failed`
        : `Downloaded ${doneCount} file${doneCount === 1 ? "" : "s"}`;

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
            const pct =
              task.totalBytes > 0
                ? (task.completedBytes / task.totalBytes) * 100
                : task.totalShards > 0
                  ? (task.completedShards / task.totalShards) * 100
                  : 0;
            const label =
              task.status === "error"
                ? "Failed"
                : task.status === "done"
                  ? "Downloaded"
                  : PHASE_LABEL[task.phase];
            return (
              <div key={task.id} className="px-4 py-2.5 border-b border-border last:border-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-foreground truncate" title={task.name}>
                    {task.name}
                  </span>
                  <span className="text-[10px] shrink-0" style={{ color: STATUS_COLOR[task.status] }}>
                    {label}
                  </span>
                </div>
                <div className="mt-1.5">
                  <Progress value={pct} />
                </div>
                <div className="mt-1 text-[10px] font-mono text-muted-foreground">
                  {task.totalBytes > 0
                    ? `${formatBytes(task.completedBytes)} / ${formatBytes(task.totalBytes)}`
                    : `${task.completedShards} / ${task.totalShards} shards`}
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
