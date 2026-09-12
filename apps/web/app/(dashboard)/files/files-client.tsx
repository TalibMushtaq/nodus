"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@repo/ui/primitives/button";
import { Section } from "@repo/ui/primitives/section";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { StatusBadge, type SyncStatus } from "@repo/ui/primitives/badge";
import { Select } from "@repo/ui/primitives/select";
import { Progress } from "@repo/ui/primitives/progress";

import { useFiles, type FileEntryView } from "../../../lib/use-files";
import { useAuth } from "../../../providers/auth-provider";
import { useUploader } from "../../../lib/use-uploader";
import { listNodes, type RelayNode } from "../../../lib/pairing";
import {
  downloadFile,
  browserDownloadDeps,
  MissingEnvelopeError,
  ShardUnavailableError,
  ShardIntegrityError,
} from "../../../lib/download";
import { startTransfer, finishTransfer } from "../../../lib/transfer-log";
import { formatBytes, timeAgo } from "../../../lib/format";

// Files view: the first UI over the Phase 14 catalog/upload/download backend.
// Scope is deliberately list + upload + download + filter/sort; rename, move,
// delete, conflict resolution, and version restore have no Relay endpoint yet
// and are rendered disabled rather than as working controls.

type SortKey = "modified" | "name" | "size";

const STATUS_FILTERS: { value: SyncStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "synced", label: "Synced" },
  { value: "pending", label: "Pending" },
  { value: "conflict", label: "Conflicts" },
  { value: "local-only", label: "Local only" },
];

/** Distinguish the download failure modes the user can actually act on. */
function describeDownloadError(err: unknown): string {
  if (err instanceof MissingEnvelopeError) return "This device has no key for that file.";
  if (err instanceof ShardUnavailableError) return "A required shard is not stored on a reachable node.";
  if (err instanceof ShardIntegrityError) return "Downloaded data failed its integrity check.";
  return err instanceof Error ? err.message : String(err);
}

function FileRowView({
  file,
  downloading,
  onDownload,
}: {
  file: FileEntryView;
  downloading: boolean;
  onDownload: (file: FileEntryView) => void;
}) {
  return (
    <div className="flex items-center gap-4 px-5 py-3.5 border-b border-border last:border-0 hover:bg-secondary/40 transition-colors">
      <div
        className="w-1 h-9 rounded-full shrink-0"
        style={{
          backgroundColor: `var(--status-${file.status === "local-only" ? "local" : file.status})`,
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">{file.name}</span>
          <StatusBadge status={file.status} variant="inline" />
        </div>
        <div className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">
          {formatBytes(file.sizeBytes)} · updated {timeAgo(file.updatedAt)}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onDownload(file)}
        disabled={!file.downloadable || downloading}
        title={file.downloadable ? undefined : "No downloadable copy on a paired node"}
        className="px-3 py-1.5 text-xs border border-border text-foreground hover:border-accent hover:text-accent transition-colors shrink-0 disabled:opacity-40 disabled:hover:border-border disabled:hover:text-foreground"
      >
        {downloading ? "Downloading…" : "Download"}
      </button>
      <button
        type="button"
        disabled
        title="Rename is not available yet"
        className="hidden sm:inline-block px-3 py-1.5 text-xs border border-border text-muted-foreground shrink-0 disabled:opacity-40"
      >
        Rename
      </button>
      <button
        type="button"
        disabled
        title="Delete is not available yet"
        className="hidden sm:inline-block px-3 py-1.5 text-xs border border-border text-muted-foreground shrink-0 disabled:opacity-40"
      >
        Delete
      </button>
    </div>
  );
}

export function FilesClient() {
  const { device } = useAuth();
  const { files, loading, error, refresh } = useFiles();
  const [sortBy, setSortBy] = useState<SortKey>("modified");
  const [filterBy, setFilterBy] = useState<SyncStatus | "all">("all");
  const [nodes, setNodes] = useState<RelayNode[]>([]);
  const [targetNode, setTargetNode] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ name: string; completed: number; total: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const currentUploadName = useRef("");

  // Load the node catalog once to resolve an upload target (primary preferred).
  useEffect(() => {
    let cancelled = false;
    listNodes()
      .then((loaded) => {
        if (cancelled) return;
        setNodes(loaded);
        const primary = loaded.find((node) => node.is_primary) ?? loaded[0];
        setTargetNode(primary?.node_id ?? null);
      })
      .catch(() => {
        // Upload is disabled without a target; the empty/error state explains it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onProgress = useCallback((event: { phase: string; completedShards: number; totalShards: number }) => {
    if (event.phase === "done") {
      setProgress(null);
      return;
    }
    setProgress({
      name: currentUploadName.current,
      completed: event.completedShards,
      total: event.totalShards,
    });
  }, []);

  const { upload, ready: uploadReady } = useUploader(onProgress);

  const handleFilesPicked = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      if (!targetNode) {
        setActionError("Pair a storage node before uploading.");
        return;
      }
      setActionError(null);
      for (const file of Array.from(fileList)) {
        currentUploadName.current = file.name;
        const log = await startTransfer({ kind: "upload", fileId: "", fileName: file.name });
        try {
          const result = await upload(file, targetNode);
          await finishTransfer(log.id, "complete", `${result.shardCount} shards`);
          refresh();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await finishTransfer(log.id, "failed", message);
          setActionError(message);
        } finally {
          setProgress(null);
          currentUploadName.current = "";
        }
      }
      // Allow re-selecting the same file in a later upload.
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [targetNode, upload, refresh],
  );

  const handleDownload = useCallback(
    async (file: FileEntryView) => {
      if (!device || file.latestVersionNumber == null || file.shardCount == null) return;
      setDownloadingId(file.fileId);
      setActionError(null);
      const log = await startTransfer({ kind: "download", fileId: file.fileId, fileName: file.name });
      try {
        const result = await downloadFile({
          fileId: file.fileId,
          versionNumber: file.latestVersionNumber,
          shardCount: file.shardCount,
          encryptedName: file.encryptedName,
          expectedVersionHash: file.versionHash,
          deps: browserDownloadDeps(device),
        });
        // Save without an intermediate URL leak: revoke once the click is queued.
        const blob = new Blob([result.data as unknown as BlobPart]);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = result.name ?? file.name;
        anchor.click();
        URL.revokeObjectURL(url);
        await finishTransfer(log.id, "complete", formatBytes(result.data.length));
      } catch (err) {
        const message = describeDownloadError(err);
        await finishTransfer(log.id, "failed", message);
        setActionError(message);
      } finally {
        setDownloadingId(null);
      }
    },
    [device],
  );

  const visible = useMemo(() => {
    const filtered = filterBy === "all" ? files : files.filter((file) => file.status === filterBy);
    const sorted = [...filtered];
    if (sortBy === "name") {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === "size") {
      sorted.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    } else {
      sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return sorted;
  }, [files, filterBy, sortBy]);

  const canUpload = Boolean(device && uploadReady && targetNode) && !progress;
  const uploadHint = !device
    ? "Waiting for device identity…"
    : nodes.length === 0
      ? "Pair a storage node to upload"
      : null;

  return (
    <div className="space-y-6 p-6">
      {error && (
        <div className="flex items-center gap-3" role="alert">
          <p className="text-xs text-destructive">{error}</p>
          <Button variant="secondary" size="sm" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}

      <Section
        title="Files"
        action={
          <div className="flex items-center gap-2">
            <Select
              aria-label="Sort files"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
            >
              <option value="modified">Sort: Modified</option>
              <option value="name">Sort: Name</option>
              <option value="size">Sort: Size</option>
            </Select>
            <Select
              aria-label="Filter files"
              value={filterBy}
              onChange={(e) => setFilterBy(e.target.value as SyncStatus | "all")}
            >
              {STATUS_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </Select>
            <Button variant="secondary" size="sm" onClick={refresh}>
              Refresh
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={!canUpload}
              title={uploadHint ?? undefined}
            >
              Upload
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              aria-label="Choose files to upload"
              className="hidden"
              onChange={(e) => void handleFilesPicked(e.target.files)}
            />
          </div>
        }
      >
        {progress && (
          <div className="mb-3 space-y-1" role="status" aria-live="polite">
            <div className="text-[11px] text-muted-foreground truncate">
              Uploading {progress.name} ({progress.completed}/{progress.total} shards)
            </div>
            <Progress value={progress.total === 0 ? 0 : (progress.completed / progress.total) * 100} />
          </div>
        )}

        {uploadHint && !loading && (
          <p className="text-xs text-muted-foreground mb-3">{uploadHint}</p>
        )}

        {actionError && (
          <p className="text-xs text-destructive mb-3" role="alert">
            {actionError}
          </p>
        )}

        {loading ? (
          <p className="text-xs text-muted-foreground px-1">Loading files…</p>
        ) : visible.length === 0 ? (
          <EmptyState
            title={files.length === 0 ? "No files yet" : "No files match this filter"}
            description={
              files.length === 0
                ? "Upload a file to store it end-to-end encrypted across your nodes."
                : "Try a different status filter."
            }
          />
        ) : (
          <div className="border border-border rounded-xl overflow-hidden bg-card">
            {visible.map((file) => (
              <FileRowView
                key={file.fileId}
                file={file}
                downloading={downloadingId === file.fileId}
                onDownload={handleDownload}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
