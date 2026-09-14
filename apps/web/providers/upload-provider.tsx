"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Icon } from "@repo/ui/primitives/icons";
import { Progress } from "@repo/ui/primitives/progress";

import { formatBytes } from "../lib/format";
import type { UploadProgressEvent } from "../lib/uploader";

// Upload queue state lives here (not in FilesClient) so the floating progress
// widget survives route changes: navigating away from Files unmounts that page
// while the upload's async loop keeps running, and a page-scoped widget simply
// vanished. The provider is mounted for the whole dashboard, owns the queue and
// the throughput sampler, and renders the widget itself.

export type UploadStatus = "queued" | "active" | "done" | "error" | "skipped";
export type UploadPhase = UploadProgressEvent["phase"];

export interface UploadTask {
  id: string;
  name: string;
  sizeBytes: number;
  completedBytes: number;
  completedShards: number;
  totalShards: number;
  phase: UploadPhase;
  status: UploadStatus;
  /** Transfer path the shards are actually taking (set once known). */
  path?: string;
  /** Display name of the storage node receiving the shards. */
  targetNodeName?: string;
  error?: string;
}

/** Human labels for the transfer-manager path enum. */
const PATH_LABEL: Record<string, string> = {
  local_signaling: "Local P2P",
  relay_signaling: "Relay WebRTC",
  buffer_relay: "Relay buffer",
  local_queue: "Queued on device",
};

const UPLOAD_STATUS_TEXT: Record<UploadStatus, string> = {
  queued: "Queued",
  active: "Uploading",
  done: "Uploaded",
  error: "Failed",
  skipped: "Skipped (already stored)",
};

const UPLOAD_STATUS_COLOR: Record<UploadStatus, string> = {
  queued: "var(--status-local)",
  active: "var(--status-pending)",
  done: "var(--status-synced)",
  error: "var(--status-conflict)",
  skipped: "var(--status-local)",
};

/**
 * What an *active* task is actually doing. The measure pass hashes the whole
 * plaintext before any bytes move, so an 800 MB file can sit here for a while
 * with no network activity — labelling it "Uploading" made that read as a hang.
 */
const UPLOAD_PHASE_TEXT: Record<UploadPhase, string> = {
  measuring: "Hashing",
  announcing: "Preparing",
  uploading: "Uploading",
  done: "Uploaded",
};

interface UploadContextValue {
  tasks: UploadTask[];
  activeId: string | null;
  speedBps: number;
  /** True when the active upload has made no byte progress for ~2s. */
  stalled: boolean;
  setTasks: Dispatch<SetStateAction<UploadTask[]>>;
  setActiveId: (id: string | null) => void;
  /** Push byte/shard progress for one task (also feeds the speed sampler). */
  reportProgress: (id: string, event: UploadProgressEvent) => void;
  /** Record which transfer path the active task's shards are using. */
  reportPath: (id: string, path: string) => void;
  dismiss: () => void;
}

const UploadContext = createContext<UploadContextValue | null>(null);

export function UploadProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [speedBps, setSpeedBps] = useState(0);
  const [stalled, setStalled] = useState(false);
  // Latest plaintext byte count reported for the active task; the sampler
  // below turns consecutive readings into a transfer rate.
  const liveBytesRef = useRef(0);
  // Consecutive sampler ticks with no byte progress (4 × 500ms ≈ 2s).
  const stallTicksRef = useRef(0);

  const reportProgress = useCallback((id: string, event: UploadProgressEvent) => {
    liveBytesRef.current = event.completedBytes;
    setTasks((previous) =>
      previous.map((task) =>
        task.id === id
          ? {
              ...task,
              completedBytes: event.completedBytes,
              completedShards: event.completedShards,
              totalShards: event.totalShards,
              phase: event.phase,
              status: "active",
            }
          : task,
      ),
    );
  }, []);

  const reportPath = useCallback((id: string, path: string) => {
    setTasks((previous) =>
      previous.map((task) => (task.id === id ? { ...task, path } : task)),
    );
  }, []);

  const dismiss = useCallback(() => setTasks([]), []);

  // Selecting a task also resets the rate counter; done here (not in the
  // sampler effect) so the effect never calls setState synchronously.
  const beginTask = useCallback((id: string | null) => {
    liveBytesRef.current = 0;
    stallTicksRef.current = 0;
    setSpeedBps(0);
    setStalled(false);
    setActiveId(id);
  }, []);

  // Whether the active task is actually moving bytes. During the measure pass
  // `completedBytes` advances at hashing speed, so a rate sampled then is a
  // hashing throughput, not an upload speed.
  const activeUploading =
    tasks.find((task) => task.id === activeId)?.phase === "uploading";

  // Sample the live byte counter every 500ms to derive a transfer rate. Only
  // while uploading, and starting from the current counter so the first tick
  // measures network throughput rather than the tail of the hashing pass. Kept
  // here rather than in the upload loop so it survives navigation.
  useEffect(() => {
    if (!activeId || !activeUploading) return;
    let lastBytes = liveBytesRef.current;
    let lastAt = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const bytes = liveBytesRef.current;
      const seconds = (now - lastAt) / 1000;
      if (seconds > 0) {
        const delta = bytes - lastBytes;
        if (delta <= 0) {
          // No progress this tick: a stalled transfer reads as 0, not as a
          // value that decays toward zero forever.
          setSpeedBps(0);
          stallTicksRef.current += 1;
        } else {
          const instant = delta / seconds;
          // Exponential smoothing so the number does not jitter every tick.
          setSpeedBps((previous) => (previous === 0 ? instant : previous * 0.5 + instant * 0.5));
          stallTicksRef.current = 0;
        }
        setStalled(stallTicksRef.current >= 4);
      }
      lastBytes = bytes;
      lastAt = now;
    }, 500);
    return () => clearInterval(timer);
  }, [activeId, activeUploading]);

  const value = useMemo<UploadContextValue>(
    () => ({
      tasks,
      activeId,
      // Never surface a stale hashing rate as an upload speed.
      speedBps: activeUploading ? speedBps : 0,
      stalled: activeUploading && stalled,
      setTasks,
      setActiveId: beginTask,
      reportProgress,
      reportPath,
      dismiss,
    }),
    [tasks, activeId, speedBps, activeUploading, stalled, beginTask, reportProgress, reportPath, dismiss],
  );

  return (
    <UploadContext.Provider value={value}>
      {children}
      <UploadQueue
        tasks={tasks}
        speedBps={activeUploading ? speedBps : 0}
        stalled={activeUploading && stalled}
        activeId={activeId}
        onDismiss={dismiss}
      />
    </UploadContext.Provider>
  );
}

export function useUpload(): UploadContextValue {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUpload must be used within an UploadProvider");
  return ctx;
}

/**
 * Google-Drive-style upload progress: a floating card pinned to the bottom
 * right of the viewport. Expanded it lists each file with its bar, the path it
 * is taking (Local P2P / Relay WebRTC / Relay buffer), and the target node.
 * When every task finishes without errors the card collapses and auto-dismisses;
 * failures stay open so the user can read them before clearing the queue.
 */
function UploadQueue({
  tasks,
  speedBps,
  stalled,
  activeId,
  onDismiss,
}: {
  tasks: UploadTask[];
  speedBps: number;
  stalled: boolean;
  activeId: string | null;
  onDismiss: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [completedCollapsed, setCompletedCollapsed] = useState(false);
  const prevAllDone = useRef(false);

  const totalBytes = tasks.reduce((sum, task) => sum + task.sizeBytes, 0);
  const completedBytes = tasks.reduce((sum, task) => sum + task.completedBytes, 0);
  const overallPct = totalBytes === 0 ? 0 : (completedBytes / totalBytes) * 100;

  const activeCount = tasks.filter((task) => task.status === "queued" || task.status === "active").length;
  const errorCount = tasks.filter((task) => task.status === "error").length;
  const doneCount = tasks.filter((task) => task.status === "done").length;
  const allDone = tasks.length > 0 && activeCount === 0;
  // Failures always stay expanded so the user can read why before clearing;
  // otherwise the user's chevron choice rules, and a completed batch collapses.
  const expanded = errorCount > 0 ? true : !collapsed && !completedCollapsed;

  // Auto-collapse then auto-dismiss only at the moment the last task finishes
  // (not on every render, so a stale completed queue from a previous visit
  // does not pop open or vanish a second after the page loads). All state
  // updates are deferred behind timers to stay outside the render loop.
  useEffect(() => {
    const wasDone = prevAllDone.current;
    prevAllDone.current = allDone;
    if (allDone && !wasDone) {
      if (errorCount > 0) return;
      const collapseAt = setTimeout(() => setCompletedCollapsed(true), 1000);
      const dismissAt = setTimeout(onDismiss, 4500);
      return () => {
        clearTimeout(collapseAt);
        clearTimeout(dismissAt);
      };
    }
    // A new batch started after a completed one: re-open the list.
    if (!allDone && wasDone) {
      const reopen = setTimeout(() => setCompletedCollapsed(false), 0);
      return () => clearTimeout(reopen);
    }
  }, [allDone, errorCount, onDismiss]);

  if (tasks.length === 0) return null;

  // The active task's phase decides the verb, so "Hashing a 800 MB file" is not
  // misreported as "Uploading" while the measure pass holds.
  const activeTask = tasks.find((task) => task.id === activeId) ?? tasks.find((task) => task.status === "active");
  const activeVerb = activeTask ? UPLOAD_PHASE_TEXT[activeTask.phase] : "Uploading";
  // Bytes only move over the network during the `uploading` phase. The measure
  // pass advances `completedBytes` at BLAKE3 hashing speed, so reporting it as a
  // transfer rate showed absurd "hundreds of MB/s before any upload" numbers.
  const activeUploading = activeTask?.phase === "uploading";
  const heading = activeCount > 0
    ? `${activeVerb} ${activeCount} file${activeCount === 1 ? "" : "s"}`
    : errorCount > 0
      ? `${errorCount} upload${errorCount === 1 ? "" : "s"} failed`
      : `Uploaded ${doneCount} file${doneCount === 1 ? "" : "s"}`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card shadow-lg overflow-hidden"
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/50"
      >
        <span className="flex items-center gap-2 min-w-0">
          <Icon
            name={errorCount > 0 ? "warning" : activeCount > 0 ? "upload" : "check"}
            size={16}
            className={activeCount > 0 ? "text-foreground animate-pulse" : "text-foreground"}
          />
          <span className="text-xs font-medium text-foreground truncate">{heading}</span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {stalled ? (
            <span className="text-[10px] font-mono text-muted-foreground">stalled</span>
          ) : activeUploading && speedBps > 0 ? (
            <span className="text-[10px] font-mono text-muted-foreground">↑ {formatBytes(speedBps)}/s</span>
          ) : (
            <span className="text-[10px] font-mono text-muted-foreground">{Math.round(overallPct)}%</span>
          )}
          <Icon name="chevron-down" size={14} className={expanded ? "rotate-180 text-muted-foreground" : "text-muted-foreground"} />
        </span>
      </button>

      {!expanded && (
        <div className="px-4 pb-2">
          <Progress value={overallPct} />
        </div>
      )}

      {expanded && (
        <div className="border-t border-border max-h-72 overflow-y-auto">
          <div className="px-4 py-2">
            <Progress value={overallPct} />
          </div>
          {tasks.map((task) => {
            const pct = task.sizeBytes === 0 ? 0 : (task.completedBytes / task.sizeBytes) * 100;
            const active = task.id === activeId;
            const pathLabel = task.path ? PATH_LABEL[task.path] ?? task.path : null;
            return (
              <div key={task.id} className="px-4 py-2.5 border-t border-border last:border-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-foreground truncate" title={task.name}>
                    {task.name}
                  </span>
                  <span className="text-[10px] shrink-0" style={{ color: UPLOAD_STATUS_COLOR[task.status] }}>
                    {task.status === "active"
                      ? UPLOAD_PHASE_TEXT[task.phase]
                      : UPLOAD_STATUS_TEXT[task.status]}
                    {active && stalled ? " · stalled" : ""}
                    {!stalled && active && task.phase === "uploading" && speedBps > 0
                      ? ` · ↑ ${formatBytes(speedBps)}/s`
                      : ""}
                  </span>
                </div>
                <div className="mt-1.5">
                  <Progress value={pct} />
                </div>
                <div className="mt-1 text-[10px] font-mono text-muted-foreground">
                  {formatBytes(task.completedBytes)} / {formatBytes(task.sizeBytes)}
                  {task.totalShards > 0 ? ` · ${task.completedShards}/${task.totalShards} shards` : ""}
                  {task.error ? ` · ${task.error}` : ""}
                </div>
                {/* How/where: the live transfer path and the receiving node. */}
                {(pathLabel || task.targetNodeName) && task.status !== "error" && (
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {pathLabel ? `via ${pathLabel}` : "choosing path…"}
                    {task.targetNodeName ? ` → ${task.targetNodeName}` : ""}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {allDone && errorCount === 0 && (
        <div className="flex items-center justify-between border-t border-border px-4 py-1.5">
          <span className="text-[10px] text-muted-foreground">All uploads finished</span>
          <button type="button" onClick={onDismiss} className="text-[10px] text-muted-foreground hover:text-foreground">
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
