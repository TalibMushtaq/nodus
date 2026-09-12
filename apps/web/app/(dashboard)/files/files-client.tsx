"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@repo/ui/primitives/button";
import { Section } from "@repo/ui/primitives/section";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import type { SyncStatus } from "@repo/ui/primitives/badge";
import { Select } from "@repo/ui/primitives/select";
import { Progress } from "@repo/ui/primitives/progress";
import { Modal, ModalHeader, ConfirmDialog } from "@repo/ui/primitives/overlay";
import { Input } from "@repo/ui/primitives/input";

import { useFiles, type FileEntryView } from "../../../lib/use-files";
import { useAuth } from "../../../providers/auth-provider";
import { useTransfer } from "../../../providers/transfer-provider";
import { useUploader } from "../../../lib/use-uploader";
import { useFileMutations } from "../../../lib/use-file-mutations";
import { useMounted } from "../../../lib/use-mounted";
import type { ShardUpload, ShardUploadResult } from "../../../lib/buffer";
import type { ShardTransferRequest } from "@repo/transfer-manager";
import { listNodes, type RelayNode } from "../../../lib/pairing";
import {
  downloadFile,
  browserDownloadDeps,
  MissingEnvelopeError,
  ShardUnavailableError,
  ShardIntegrityError,
} from "../../../lib/download";
import { startTransfer, finishTransfer, logTransferAction } from "../../../lib/transfer-log";
import { formatBytes, timeAgo } from "../../../lib/format";
import { measurePlaintext, type FileMeasurement } from "../../../lib/uploader";
import { findIncompleteByHash, findStoredDuplicate, type FileStorageState } from "../../../lib/file-view";

// Files view: the first UI over the Phase 14 catalog/upload/download backend.
// Scope is list + upload + download + filter/sort, plus rename and delete, which
// are metadata sync events (`FILE_CREATED` upsert / `TOMBSTONE_CREATED`). Move,
// conflict resolution, and version restore have no endpoint yet and are not
// rendered.

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

const STORAGE_LABELS: Record<FileStorageState, { label: string; color: string }> = {
  node: { label: "On node", color: "var(--status-synced)" },
  relay: { label: "Relay buffer", color: "var(--status-pending)" },
  transferring: { label: "Transferring", color: "var(--status-pending)" },
  local: { label: "Local only", color: "var(--status-local)" },
  conflict: { label: "Conflict", color: "var(--status-conflict)" },
};

/**
 * Where the latest version actually lives. Deliberately distinct from the
 * shared "Synced" badge: that label implied the bytes were durable on a node
 * even when they were only in the Relay's temporary buffer.
 */
function FileStorageBadge({ state }: { state: FileStorageState }) {
  const cfg = STORAGE_LABELS[state];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium shrink-0" style={{ color: cfg.color }}>
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: cfg.color }} />
      {cfg.label}
    </span>
  );
}

function FileRowView({
  file,
  downloading,
  busy,
  deleting,
  onDownload,
  onResync,
  onRename,
  onDelete,
}: {
  file: FileEntryView;
  downloading: boolean;
  busy: boolean;
  deleting: boolean;
  onDownload: (file: FileEntryView) => void;
  onResync: (file: FileEntryView) => void;
  onRename: (file: FileEntryView) => void;
  onDelete: (file: FileEntryView) => void;
}) {
  return (
    <div
      className={`flex items-center gap-4 px-5 py-3.5 border-b border-border last:border-0 hover:bg-secondary/40 transition-colors ${
        deleting ? "opacity-50" : ""
      }`}
    >
      <div
        className="w-1 h-9 rounded-full shrink-0"
        style={{
          backgroundColor: `var(--status-${file.status === "local-only" ? "local" : file.status})`,
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">{file.name}</span>
          {deleting ? (
            <span className="text-xs font-medium text-muted-foreground shrink-0">Deleting…</span>
          ) : (
            <FileStorageBadge state={file.storageState} />
          )}
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
      {file.storageState !== "node" && (
        <button
          type="button"
          onClick={() => onResync(file)}
          disabled={busy}
          title="Retry backing this file up to a storage node"
          className="hidden sm:inline-block px-3 py-1.5 text-xs border border-accent/40 text-accent hover:bg-accent/10 transition-colors shrink-0 disabled:opacity-40"
        >
          Resync
        </button>
      )}
      <button
        type="button"
        onClick={() => onRename(file)}
        disabled={busy}
        className="hidden sm:inline-block px-3 py-1.5 text-xs border border-border text-foreground hover:border-accent hover:text-accent transition-colors shrink-0 disabled:opacity-40"
      >
        Rename
      </button>
      <button
        type="button"
        onClick={() => onDelete(file)}
        disabled={busy}
        className="hidden sm:inline-block px-3 py-1.5 text-xs border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors shrink-0 disabled:opacity-40"
      >
        Delete
      </button>
    </div>
  );
}

export function FilesClient() {
  const { device } = useAuth();
  const { files, loading, error, refresh, forget } = useFiles();
  // Device identity and the node catalog are client-only, so the SSR pass would
  // otherwise render the Upload control differently from the client's first
  // pass. `useMounted` returns the server snapshot during hydration, keeping both
  // renders identical, then flips to the client value.
  const mounted = useMounted();
  const [sortBy, setSortBy] = useState<SortKey>("modified");
  const [filterBy, setFilterBy] = useState<SyncStatus | "all">("all");
  const [nodes, setNodes] = useState<RelayNode[]>([]);
  const [targetNode, setTargetNode] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ name: string; phase: string; completed: number; total: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const currentUploadName = useRef("");
  // Content hashes accepted in this session. The catalog only refreshes after
  // an upload completes, so this catches a second identical file selected in
  // the same batch (or before the refresh lands) without a round trip.
  const sessionHashes = useRef<Set<string>>(new Set());

  // Rename/delete dialog state. `mutating` disables the actions while a
  // metadata event is in flight so the same file cannot be changed twice.
  const [renameTarget, setRenameTarget] = useState<FileEntryView | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FileEntryView | null>(null);
  const [mutating, setMutating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [resyncHint, setResyncHint] = useState<string | null>(null);

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
      phase: event.phase,
      completed: event.completedShards,
      total: event.totalShards,
    });
  }, []);

  const { uploadShard, ready: transferReady, queuedCount, hasPending, retryPending } = useTransfer();

  // Route each shard through the Transfer Manager's fallback chain so a node on
  // the same LAN receives it directly (Path A) instead of always buffering via
  // the Relay (Path C). The manager falls through to the Relay buffer when no
  // direct path is available. Before the manager finishes hydrating we let the
  // uploader use its default relay post so an early upload is not blocked.
  const transferPostShard = useCallback(
    async (dto: ShardUpload): Promise<ShardUploadResult> => {
      const result = await uploadShard({
        transferId: dto.transferId,
        fileId: dto.fileId,
        versionNumber: dto.versionNumber,
        shardIndex: dto.shardIndex,
        data: dto.data,
        hash: dto.hash,
        targetNode: dto.targetNode as ShardTransferRequest["targetNode"],
        sourceDevice: dto.sourceDevice,
      });
      if (!result.success) {
        throw new Error(result.error ?? "shard transfer failed");
      }
      return { buffer_id: "", status: result.path };
    },
    [uploadShard],
  );

  const { upload } = useUploader(onProgress, transferReady ? transferPostShard : undefined);
  const { rename, remove } = useFileMutations();
  const handleFilesPicked = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      if (!targetNode) {
        setActionError("Pair a storage node before uploading.");
        return;
      }
      setActionError(null);
      const skipped: string[] = [];
      for (const file of Array.from(fileList)) {
        currentUploadName.current = file.name;

        // Measure once so an exact-content duplicate is rejected before any
        // network work; the same result is handed to the uploader so the file
        // is not hashed a second time.
        let measured: FileMeasurement;
        try {
          measured = await measurePlaintext(file, onProgress);
        } catch (err) {
          setProgress(null);
          currentUploadName.current = "";
          setActionError(err instanceof Error ? err.message : String(err));
          continue;
        }

        const duplicate = findStoredDuplicate(files, measured.versionHash);
        if (duplicate || sessionHashes.current.has(measured.versionHash)) {
          setProgress(null);
          currentUploadName.current = "";
          skipped.push(file.name);
          continue;
        }
        // An announced-but-incomplete file with the same content is resumed
        // (same fileId/version) rather than creating a duplicate, so re-selecting
        // a failed upload completes the original entry.
        const incomplete = findIncompleteByHash(files, measured.versionHash);
        sessionHashes.current.add(measured.versionHash);

        const log = await startTransfer({
          kind: "upload",
          fileId: incomplete?.fileId ?? "",
          fileName: file.name,
        });
        try {
          const target = incomplete
            ? { fileId: incomplete.fileId, versionNumber: incomplete.latestVersionNumber ?? 1 }
            : undefined;
          const result = await upload(file, targetNode, measured, target);
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
      if (skipped.length > 0) {
        setActionError(
          skipped.length === 1
            ? `"${skipped[0]}" is already stored — skipped.`
            : `${skipped.length} files were already stored — skipped.`,
        );
      }
      // Allow re-selecting the same file in a later upload.
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [targetNode, upload, refresh, files, onProgress],
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

  const openRename = useCallback((file: FileEntryView) => {
    setMutationError(null);
    setRenameValue(file.name);
    setRenameTarget(file);
  }, []);

  const openDelete = useCallback((file: FileEntryView) => {
    setMutationError(null);
    setDeleteTarget(file);
  }, []);

  const confirmRename = useCallback(async () => {
    if (!renameTarget) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    setMutating(true);
    setMutationError(null);
    try {
      await rename(renameTarget.fileId, renameTarget.parentFolderId, trimmed);
      setRenameTarget(null);
      // Re-fetch so the decrypted name/updated_at reflect the new metadata.
      refresh();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutating(false);
    }
  }, [renameTarget, renameValue, rename, refresh]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setMutating(true);
    setMutationError(null);
    setDeletingId(deleteTarget.fileId);
    try {
      await remove(deleteTarget.fileId);
      // Drop it from the local cache/list immediately. A full refresh is
      // deliberately not issued here: until the Relay filters tombstones a
      // snapshot would re-add it, and the next refresh reconciles anyway.
      await forget(deleteTarget.fileId);
      await logTransferAction({
        kind: "delete",
        fileId: deleteTarget.fileId,
        fileName: deleteTarget.name,
        outcome: "complete",
        detail: "Moved to Tombstone",
      });
      setDeleteTarget(null);
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
      setMutating(false);
    }
  }, [deleteTarget, remove, forget]);

  const resync = useCallback(
    (file: FileEntryView) => {
      setMutationError(null);
      setResyncHint(null);
      if (hasPending(file.fileId)) {
        // Shards are queued locally (Path D): drain now instead of waiting for
        // the next reconnect, then re-read the catalog.
        retryPending();
        window.setTimeout(refresh, 1500);
        return;
      }
      // No retained ciphertext for this file, so it cannot be re-sent without
      // the original bytes. Ask the user to re-select it; the upload handler
      // matches by content hash and resumes the existing file.
      setResyncHint(`Select the original “${file.name}” to resync it.`);
      fileInputRef.current?.click();
    },
    [hasPending, retryPending, refresh],
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

  const deviceReady = mounted && Boolean(device);
  const canUpload = deviceReady && Boolean(targetNode) && !progress;
  const uploadHint = !deviceReady
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
            {queuedCount > 0 && (
              <Button variant="secondary" size="sm" onClick={() => retryPending()}>
                Retry {queuedCount} pending
              </Button>
            )}
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
              {progress.phase === "measuring"
                ? `Checking ${progress.name} for duplicates…`
                : `Uploading ${progress.name} (${progress.completed}/${progress.total} shards)`}
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

        {mutationError && (
          <p className="text-xs text-destructive mb-3" role="alert">
            {mutationError}
          </p>
        )}

        {resyncHint && (
          <p className="text-xs text-muted-foreground mb-3" role="status">
            {resyncHint}
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
                busy={mutating}
                deleting={deletingId === file.fileId}
                onDownload={handleDownload}
                onResync={resync}
                onRename={openRename}
                onDelete={openDelete}
              />
            ))}
          </div>
        )}
      </Section>

      {renameTarget && (
        <Modal
          className="w-[420px] max-w-full"
          onClose={mutating ? () => undefined : () => setRenameTarget(null)}
        >
          <ModalHeader
            title="Rename file"
            onClose={mutating ? () => undefined : () => setRenameTarget(null)}
          />
          <div className="p-5 space-y-4">
            <Input
              label="Name"
              value={renameValue}
              autoFocus
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void confirmRename()}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRenameTarget(null)} disabled={mutating}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void confirmRename()}
                disabled={mutating || !renameValue.trim()}
              >
                {mutating ? "Saving…" : "Rename"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete file"
          destructive
          busy={mutating}
          confirmLabel="Delete"
          description={
            <>
              Delete “{deleteTarget.name}”? It will be removed from your vault. The stored copy is
              cleaned up under the retention policy.
            </>
          }
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
