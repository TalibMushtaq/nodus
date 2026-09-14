"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@repo/ui/primitives/button";
import { Section } from "@repo/ui/primitives/section";
import { PageHeader } from "@repo/ui/primitives/page-header";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import type { SyncStatus } from "@repo/ui/primitives/badge";
import { Select } from "@repo/ui/primitives/select";
import { Progress } from "@repo/ui/primitives/progress";
import { Modal, ModalHeader, ConfirmDialog } from "@repo/ui/primitives/overlay";
import { Input } from "@repo/ui/primitives/input";
import { Icon } from "@repo/ui/primitives/icons";

import { useFiles, type FileEntryView, type FolderView } from "../../../lib/use-files";
import { useAuth } from "../../../providers/auth-provider";
import { useTransfer } from "../../../providers/transfer-provider";
import { useUploader } from "../../../lib/use-uploader";
import { useFileMutations } from "../../../lib/use-file-mutations";
import { useFolderMutations } from "../../../lib/folder-mutations";
import { useMounted } from "../../../lib/use-mounted";
import { usePreferences } from "../../../lib/preferences";
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
import { buildFolderZip, describeFolderSkips, triggerBlobDownload } from "../../../lib/folder-download";
import { getTrustedNodes } from "../../../lib/trusted-nodes";
import { ensureNodeTrusted } from "../../../lib/auto-pair";
import { startTransfer, finishTransfer, logTransferAction } from "../../../lib/transfer-log";
import { activityPathFromTransfer } from "../../../lib/overview";
import { formatBytes, shortId, timeAgo } from "../../../lib/format";
import {
  measurePlaintext,
  type FileMeasurement,
  type UploadProgressEvent,
} from "../../../lib/uploader";
import { useUpload, type UploadTask } from "../../../providers/upload-provider";
import { findIncompleteByHash, findStoredDuplicate, type FileStorageState } from "../../../lib/file-view";

// Files view: catalog/upload/download plus a folder tree. Folders are metadata
// sync events (FOLDER_CREATED / FOLDER_DELETED); the current folder is the
// upload target and the breadcrumb is navigation. Uploads run sequentially with
// byte-level progress and a client-computed transfer rate.

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
  if (err instanceof ShardUnavailableError) {
    // A shard can be listed NODE_STORED yet unreachable because this browser
    // never paired with the node that holds it — a pairing gap, not data loss.
    return err.message.includes("no_trusted_host")
      ? "This browser isn't paired with the node storing that file — pair it on the Devices page, then retry."
      : "A required shard isn't stored on a reachable node yet.";
  }
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

// ── Row components ─────────────────────────────────────────────────────

/**
 * Small accessible popover menu anchored to a trigger. Closes on outside click
 * and Escape. Client-only; used by the folder tiles (rename / download /
 * properties / delete) so the tile itself stays a single tap target.
 */
function MenuButton({
  label,
  items,
}: {
  label: string;
  items: { label: string; onSelect: () => void; destructive?: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="absolute top-1.5 right-1.5 z-10">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((previous) => !previous);
        }}
        className="p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
      >
        <Icon name="more" size={16} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-36 py-1 rounded-lg border border-border bg-card shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                item.onSelect();
              }}
              className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-secondary ${
                item.destructive ? "text-destructive" : "text-foreground"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// File-manager style folder tile: a large folder glyph with the name beneath it
// and a three-dots menu (rename / download as zip / properties / delete).
function FolderTile({
  folder,
  busy,
  downloading,
  onOpen,
  onRename,
  onDownload,
  onProperties,
  onDelete,
}: {
  folder: FolderView;
  busy: boolean;
  downloading: boolean;
  onOpen: (folder: FolderView) => void;
  onRename: (folder: FolderView) => void;
  onDownload: (folder: FolderView) => void;
  onProperties: (folder: FolderView) => void;
  onDelete: (folder: FolderView) => void;
}) {
  return (
      <div className="card-interactive group relative flex flex-col items-center justify-start gap-2 p-4 rounded-2xl border border-border bg-card hover:border-accent/50">
      <button
        type="button"
        onClick={() => onOpen(folder)}
        title={folder.name}
        className="flex flex-col items-center gap-2 w-full"
      >
        <Icon name="folder" size={44} className="text-accent shrink-0" />
        <span className="text-xs font-medium text-foreground text-center line-clamp-2 break-all">
          {folder.name}
        </span>
      </button>
      <MenuButton
        label={`Actions for ${folder.name}`}
        items={[
          { label: "Rename", onSelect: () => onRename(folder) },
          {
            label: downloading ? "Downloading…" : "Download (.zip)",
            onSelect: () => {
              if (!downloading) onDownload(folder);
            },
          },
          { label: "Properties", onSelect: () => onProperties(folder) },
          { label: "Delete", onSelect: () => onDelete(folder), destructive: true },
        ]}
      />
      {busy && (
        <span className="absolute bottom-1.5 right-2 text-[10px] text-muted-foreground">…</span>
      )}
    </div>
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
  onMove,
  onDelete,
}: {
  file: FileEntryView;
  downloading: boolean;
  busy: boolean;
  deleting: boolean;
  onDownload: (file: FileEntryView) => void;
  onResync: (file: FileEntryView) => void;
  onRename: (file: FileEntryView) => void;
  onMove: (file: FileEntryView) => void;
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
        onClick={() => onMove(file)}
        disabled={busy}
        className="hidden sm:inline-block px-3 py-1.5 text-xs border border-border text-foreground hover:border-accent hover:text-accent transition-colors shrink-0 disabled:opacity-40"
      >
        Move
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

/** Flatten the folder tree into indented options for the move-to-folder dialog. */
function folderOptions(folders: FolderView[]): { id: string; label: string }[] {
  const byParent = new Map<string | null, FolderView[]>();
  for (const folder of folders) {
    const siblings = byParent.get(folder.parentFolderId) ?? [];
    siblings.push(folder);
    byParent.set(folder.parentFolderId, siblings);
  }
  const options: { id: string; label: string }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    const children = (byParent.get(parentId) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      options.push({ id: child.folderId, label: `${"  ".repeat(depth)}${child.name}` });
      walk(child.folderId, depth + 1);
    }
  };
  walk(null, 0);
  return options;
}

/**
 * Recursively summarize a folder's contents for the Properties dialog: total
 * file bytes, direct file count, and descendant folder count. `depth` guards
 * against a corrupt `parent_folder_id` cycle.
 */
function folderContents(
  folderId: string,
  folders: FolderView[],
  files: FileEntryView[],
  depth = 0,
): { bytes: number; files: number; folders: number } {
  if (depth > 64) return { bytes: 0, files: 0, folders: 0 };
  let bytes = 0;
  let fileCount = 0;
  let folderCount = 0;
  for (const file of files) {
    if ((file.parentFolderId ?? null) === folderId) {
      bytes += file.sizeBytes ?? 0;
      fileCount += 1;
    }
  }
  for (const folder of folders) {
    if ((folder.parentFolderId ?? null) === folderId) {
      folderCount += 1;
      const child = folderContents(folder.folderId, folders, files, depth + 1);
      bytes += child.bytes;
      fileCount += child.files;
      folderCount += child.folders;
    }
  }
  return { bytes, files: fileCount, folders: folderCount };
}

export function FilesClient() {
  const { device } = useAuth();
  const { files, folders, loading, error, refresh, forget, forgetFolder } = useFiles();
  // Device identity and the node catalog are client-only, so the SSR pass would
  // otherwise render the Upload control differently from the client's first
  // pass. `useMounted` returns the server snapshot during hydration, keeping both
  // renders identical, then flips to the client value.
  const mounted = useMounted();
  // Shard size is a device preference; the uploader and the duplicate-check
  // measurement must agree on it or the announced shard_count would drift.
  const { preferences } = usePreferences();
  const shardSizeBytes = preferences.shardSizeBytes;
  const [sortBy, setSortBy] = useState<SortKey>("modified");
  const [filterBy, setFilterBy] = useState<SyncStatus | "all">("all");
  const [nodes, setNodes] = useState<RelayNode[]>([]);
  const [targetNode, setTargetNode] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  // Upload queue state lives in the global provider so its widget survives
  // navigating away from Files mid-upload (the upload loop keeps running).
  const { tasks: uploads, setTasks: setUploads, setActiveId, reportProgress, reportPath } = useUpload();
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  // Set when a download failed because no trusted node host was known, or when
  // the browser has no paired node at all — both mean the user must pair one.
  const [pairingNudge, setPairingNudge] = useState(false);
  const [trustedNodeCount, setTrustedNodeCount] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Content hashes accepted in this session. The catalog only refreshes after
  // an upload completes, so this catches a second identical file selected in
  // the same batch (or before the refresh lands) without a round trip.
  const sessionHashes = useRef<Set<string>>(new Set());
  // Per-file progress/path sinks. Uploads run sequentially, so the hook's
  // single onProgress callback and the shard path reporter are routed to the
  // active task.
  const progressHandlerRef = useRef<((event: UploadProgressEvent) => void) | null>(null);
  const pathHandlerRef = useRef<((path: string) => void) | null>(null);
  // Path the last shard actually used (local P2P / relay / buffer). Captured in
  // transferPostShard and written to the activity log on completion, where the
  // catalog no longer records how the bytes arrived.
  const activePathRef = useRef<ReturnType<typeof activityPathFromTransfer>>(undefined);

  // Rename/delete/move dialog state. `mutating` disables the actions while a
  // metadata event is in flight so the same file cannot be changed twice.
  const [renameTarget, setRenameTarget] = useState<FileEntryView | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FileEntryView | null>(null);
  const [moveTarget, setMoveTarget] = useState<FileEntryView | null>(null);
  const [moveFolderId, setMoveFolderId] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<FolderView | null>(null);
  const [folderRenameTarget, setFolderRenameTarget] = useState<FolderView | null>(null);
  const [folderRenameValue, setFolderRenameValue] = useState("");
  const [folderPropsTarget, setFolderPropsTarget] = useState<FolderView | null>(null);
  // Folder-zip download progress; `folderDownloadId` gates the trigger so the
  // same folder cannot be archived twice concurrently.
  const [folderDownload, setFolderDownload] = useState<{ name: string; completed: number; total: number } | null>(
    null,
  );
  const [folderDownloadId, setFolderDownloadId] = useState<string | null>(null);
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

  // Snapshot how many storage nodes this browser has paired with. Zero means
  // downloads of node-stored files cannot work — surfacing a pairing CTA is
  // more honest than relabeling every failure as data loss.
  useEffect(() => {
    let cancelled = false;
    void getTrustedNodes().then((nodes) => {
      if (!cancelled) setTrustedNodeCount(nodes.length);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onProgress = useCallback((event: UploadProgressEvent) => {
    progressHandlerRef.current?.(event);
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
        // Byte-level progress for whichever path runs (WebRTC or Relay XHR).
        onProgress: dto.onProgress,
      });
      // Record the successful path even if a later shard fails, so the activity
      // entry (and the upload widget) reflects how the bytes actually travelled.
      if (result.success) {
        activePathRef.current = activityPathFromTransfer(result.path);
        pathHandlerRef.current?.(result.path);
      } else {
        throw new Error(result.error ?? "shard transfer failed");
      }
      return { buffer_id: "", status: result.path };
    },
    [uploadShard],
  );

  const { upload } = useUploader(onProgress, transferReady ? transferPostShard : undefined);
  const { rename, remove } = useFileMutations();
  const { create: createFolder, rename: renameFolder, remove: removeFolder } = useFolderMutations();

  const handleFilesPicked = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      if (!targetNode) {
        setActionError("Pair a storage node before uploading.");
        return;
      }
      setActionError(null);
      // Design B: proactively pair the chosen node so downloads (and Path A
      // WebRTC transfers) work after this upload — no dialog needed. Fire-and-
      // forget by design: the upload above must never block on a host probe, and
      // a failed auto-pair is harmless because the Relay-mediated download
      // fallback covers shard fetches regardless.
      void ensureNodeTrusted(targetNode);
      const chosen = Array.from(fileList);
      // Name the receiving node up front so the widget can say where shards go.
      const targetNodeName =
        nodes.find((node) => node.node_id === targetNode)?.display_name ?? shortId(targetNode);
      const tasks: UploadTask[] = chosen.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        sizeBytes: file.size,
        completedBytes: 0,
        completedShards: 0,
        totalShards: 0,
        phase: "measuring",
        status: "queued",
        targetNodeName,
      }));
      setUploads((previous) => [...previous, ...tasks]);
      const skipped: string[] = [];

      // Files are uploaded one at a time so each one's event batches stay
      // ordered and progress is attributable to a single task. Shards *within*
      // a file run through the uploader's bounded pool, so a large file still
      // overlaps its shard transfers.
      for (let index = 0; index < chosen.length; index += 1) {
        const file = chosen[index]!;
        const task = tasks[index]!;
        activePathRef.current = undefined;
        setActiveId(task.id);
        const updateTask = (patch: Partial<UploadTask>) => {
          setUploads((previous) => previous.map((t) => (t.id === task.id ? { ...t, ...patch } : t)));
        };
        progressHandlerRef.current = (event) => reportProgress(task.id, event);
        pathHandlerRef.current = (path) => reportPath(task.id, path);

        try {
          // Measure once so an exact-content duplicate is rejected before any
          // network work; the same result is handed to the uploader so the file
          // is not hashed a second time.
          const measured: FileMeasurement = await measurePlaintext(file, onProgress, shardSizeBytes);

          const duplicate = findStoredDuplicate(files, measured.versionHash);
          if (duplicate || sessionHashes.current.has(measured.versionHash)) {
            skipped.push(file.name);
            updateTask({ status: "skipped" });
            continue;
          }
          // An announced-but-incomplete file with the same content is resumed
          // (same fileId/version) rather than creating a duplicate, so
          // re-selecting a failed upload completes the original entry.
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
            const result = await upload(file, targetNode, measured, target, currentFolderId, shardSizeBytes);
            await finishTransfer(log.id, "complete", `${result.shardCount} shards`, activePathRef.current);
            updateTask({ status: "done", completedBytes: file.size, completedShards: result.shardCount, totalShards: result.shardCount });
            refresh();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await finishTransfer(log.id, "failed", message, activePathRef.current);
            updateTask({ status: "error", error: message });
            setActionError(message);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          updateTask({ status: "error", error: message });
          setActionError(message);
        }
      }

      progressHandlerRef.current = null;
      pathHandlerRef.current = null;
      setActiveId(null);
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
    [targetNode, nodes, upload, refresh, files, onProgress, currentFolderId, shardSizeBytes, setUploads, setActiveId, reportProgress, reportPath],
  );

  const handleDownload = useCallback(
    async (file: FileEntryView) => {
      if (!device || file.latestVersionNumber == null || file.shardCount == null) return;
      setDownloadingId(file.fileId);
      setActionError(null);
      // Downloads fetch straight from a trusted LAN node, so the path is local
      // P2P by construction; recorded so Activity can label it.
      const log = await startTransfer({
        kind: "download",
        fileId: file.fileId,
        fileName: file.name,
        path: "local",
      });
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

  const openMove = useCallback((file: FileEntryView) => {
    setMutationError(null);
    setMoveFolderId(file.parentFolderId);
    setMoveTarget(file);
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

  const confirmMove = useCallback(async () => {
    if (!moveTarget) return;
    if (moveFolderId === moveTarget.parentFolderId) {
      setMoveTarget(null);
      return;
    }
    setMutating(true);
    setMutationError(null);
    try {
      // A move reuses the rename upsert (FILE_CREATED) with a new parent id,
      // keeping the name and versions untouched.
      await rename(moveTarget.fileId, moveFolderId, moveTarget.name);
      setMoveTarget(null);
      refresh();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutating(false);
    }
  }, [moveTarget, moveFolderId, rename, refresh]);

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

  const confirmCreateFolder = useCallback(async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    setMutating(true);
    setMutationError(null);
    try {
      await createFolder(trimmed, currentFolderId);
      setNewFolderOpen(false);
      setNewFolderName("");
      refresh();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutating(false);
    }
  }, [newFolderName, createFolder, currentFolderId, refresh]);

  const confirmDeleteFolder = useCallback(async () => {
    if (!deleteFolderTarget) return;
    setMutating(true);
    setMutationError(null);
    try {
      await removeFolder(deleteFolderTarget.folderId);
      await forgetFolder(deleteFolderTarget.folderId);
      setDeleteFolderTarget(null);
      refresh();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutating(false);
    }
  }, [deleteFolderTarget, removeFolder, forgetFolder, refresh]);

  const confirmRenameFolder = useCallback(async () => {
    if (!folderRenameTarget) return;
    const trimmed = folderRenameValue.trim();
    if (!trimmed || trimmed === folderRenameTarget.name) {
      setFolderRenameTarget(null);
      return;
    }
    setMutating(true);
    setMutationError(null);
    try {
      await renameFolder(folderRenameTarget.folderId, folderRenameTarget.parentFolderId, trimmed);
      setFolderRenameTarget(null);
      refresh();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutating(false);
    }
  }, [folderRenameTarget, folderRenameValue, renameFolder, refresh]);

  // Archive the folder's contents into one zip. Each file is fetched and
  // decrypted individually; not-yet-stored files are skipped so one bad file
  // does not block the whole archive.
  const handleFolderDownload = useCallback(
    async (folder: FolderView) => {
      if (!device) {
        setActionError("Sign in to download.");
        return;
      }
      if (folderDownloadId) return;
      setActionError(null);
      setMutationError(null);
      setFolderDownloadId(folder.folderId);
      setFolderDownload({ name: folder.name, completed: 0, total: 0 });
      // Folder archives fetch each file from a trusted LAN node, so the path is
      // local P2P; recorded for the Activity view like single-file downloads.
      const log = await startTransfer({
        kind: "download",
        fileId: "",
        fileName: `${folder.name}.zip`,
        path: "local",
      });
      try {
        const archive = await buildFolderZip({
          folderName: folder.name,
          folderId: folder.folderId,
          folders,
          files,
          deps: browserDownloadDeps(device),
          onProgress: (completed, total) => setFolderDownload({ name: folder.name, completed, total }),
        });
        if (archive.fileCount === 0) {
          // Nothing was added: do not hand the user an empty archive.
          await finishTransfer(log.id, "failed", "no downloadable files");
          const { message, pairingNeeded } = describeFolderSkips(archive.skipped);
          setPairingNudge(pairingNeeded);
          setActionError(
            archive.skipped.length > 0
              ? `${archive.skipped.length} file(s) in “${folder.name}” could not be downloaded: ${message}`
              : `“${folder.name}” has no files to download.`,
          );
        } else {
          triggerBlobDownload(archive.data, archive.fileName);
          await finishTransfer(log.id, "complete", `${archive.fileCount} files, ${formatBytes(archive.bytes)}`);
          if (archive.skipped.length > 0) {
            const { message, pairingNeeded } = describeFolderSkips(archive.skipped);
            setPairingNudge(pairingNeeded);
            setActionError(`${archive.skipped.length} file(s) were left out of the zip: ${message}`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await finishTransfer(log.id, "failed", message);
        setActionError(message);
      } finally {
        setFolderDownload(null);
        setFolderDownloadId(null);
      }
    },
    [device, folders, files, folderDownloadId],
  );

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

  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.folderId, folder])), [folders]);

  // Breadcrumb root → current. Guards against a cycle from bad metadata.
  const breadcrumb = useMemo(() => {
    const trail: FolderView[] = [];
    const seen = new Set<string>();
    let id = currentFolderId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const folder = folderById.get(id);
      if (!folder) break;
      trail.unshift(folder);
      id = folder.parentFolderId;
    }
    return trail;
  }, [currentFolderId, folderById]);

  const visibleFolders = useMemo(
    () =>
      folders
        .filter((folder) => folder.parentFolderId === currentFolderId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [folders, currentFolderId],
  );

  const visible = useMemo(() => {
    const inFolder = files.filter((file) => (file.parentFolderId ?? null) === currentFolderId);
    const filtered = filterBy === "all" ? inFolder : inFolder.filter((file) => file.status === filterBy);
    const sorted = [...filtered];
    if (sortBy === "name") {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortBy === "size") {
      sorted.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    } else {
      sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return sorted;
  }, [files, filterBy, sortBy, currentFolderId]);

  const uploading = uploads.some((task) => task.status === "queued" || task.status === "active");
  const deviceReady = mounted && Boolean(device);
  const canUpload = deviceReady && Boolean(targetNode) && !uploading;
  const uploadHint = !deviceReady
    ? "Waiting for device identity…"
    : nodes.length === 0
      ? "Pair a storage node to upload"
      : null;
  const moveOptions = useMemo(() => folderOptions(folders), [folders]);

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6">
      {/* The upload queue widget is rendered globally by UploadProvider so it
          survives navigating away from this page mid-upload. */}
      <PageHeader
        eyebrow="Storage"
        title="Backups"
        description="Every file in your vault, stored end-to-end encrypted across your own nodes."
      />

      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-2.5" role="alert">
          <p className="text-xs text-destructive">{error}</p>
          <Button variant="secondary" size="sm" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}

      {(pairingNudge || (trustedNodeCount === 0 && files.some((file) => file.storageState === "node"))) && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/40 px-4 py-2.5">
          <p className="text-xs text-foreground">
            {pairingNudge
              ? "Downloads failed because this browser isn't trusted by the storage node holding those files."
              : "No storage node is paired with this browser yet — files backed up to a node can't be downloaded until you pair one."}
          </p>
          <Link
            href="/pair"
            className="shrink-0 text-xs font-medium text-foreground underline underline-offset-2 hover:text-accent"
          >
            Pair a node
          </Link>
        </div>
      )}

      <Section
        title="All files"
        action={
          <div className="flex flex-wrap items-center gap-2">
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
              variant="secondary"
              size="sm"
              onClick={() => {
                setMutationError(null);
                setNewFolderName("");
                setNewFolderOpen(true);
              }}
              disabled={!deviceReady}
            >
              New folder
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
        {uploadHint && !loading && (
          <p className="text-xs text-muted-foreground mb-3">{uploadHint}</p>
        )}

        {folderDownload && (
          <div className="mb-3 space-y-1" role="status" aria-live="polite">
            <div className="text-[11px] text-muted-foreground truncate">
              {folderDownload.total > 0
                ? `Preparing “${folderDownload.name}.zip” (${folderDownload.completed}/${folderDownload.total} files)…`
                : `Preparing “${folderDownload.name}.zip”…`}
            </div>
            <Progress
              value={
                folderDownload.total === 0
                  ? 0
                  : (folderDownload.completed / folderDownload.total) * 100
              }
            />
          </div>
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

        {/* Breadcrumb navigation. Root is always tappable so the tree can be
            traversed without a separate sidebar. */}
        <nav className="flex items-center gap-1.5 mb-3 text-xs" aria-label="Breadcrumb">
          <button
            type="button"
            onClick={() => setCurrentFolderId(null)}
            className={currentFolderId === null ? "text-foreground font-medium" : "text-muted-foreground hover:text-accent"}
          >
            Backups
          </button>
          {breadcrumb.map((folder) => (
            <span key={folder.folderId} className="flex items-center gap-1.5">
              <span className="text-muted-foreground">/</span>
              <button
                type="button"
                onClick={() => setCurrentFolderId(folder.folderId)}
                className={
                  folder.folderId === currentFolderId
                    ? "text-foreground font-medium"
                    : "text-muted-foreground hover:text-accent"
                }
              >
                {folder.name}
              </button>
            </span>
          ))}
        </nav>

        {loading ? (
          <p className="text-xs text-muted-foreground px-1">Loading files…</p>
        ) : visibleFolders.length === 0 && visible.length === 0 ? (
          <EmptyState
            icon="folder"
            title={files.length === 0 && folders.length === 0 ? "No files yet" : "This folder is empty"}
            description={
              files.length === 0 && folders.length === 0
                ? "Upload a file to store it end-to-end encrypted across your nodes."
                : "Upload a file or create a folder here."
            }
          />
        ) : (
          <div className="space-y-4">
            {visibleFolders.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                {visibleFolders.map((folder) => (
                  <FolderTile
                    key={folder.folderId}
                    folder={folder}
                    busy={mutating}
                    downloading={folderDownloadId === folder.folderId}
                    onOpen={(target) => setCurrentFolderId(target.folderId)}
                    onRename={(target) => {
                      setMutationError(null);
                      setFolderRenameValue(target.name);
                      setFolderRenameTarget(target);
                    }}
                    onDownload={handleFolderDownload}
                    onProperties={(target) => setFolderPropsTarget(target)}
                    onDelete={(target) => {
                      setMutationError(null);
                      setDeleteFolderTarget(target);
                    }}
                  />
                ))}
              </div>
            )}
            {visible.length > 0 && (
              <div className="border border-border rounded-2xl overflow-hidden bg-card elev-card">
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
                    onMove={openMove}
                    onDelete={openDelete}
                  />
                ))}
              </div>
            )}
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

      {moveTarget && (
        <Modal
          className="w-[420px] max-w-full"
          onClose={mutating ? () => undefined : () => setMoveTarget(null)}
        >
          <ModalHeader
            title="Move file"
            onClose={mutating ? () => undefined : () => setMoveTarget(null)}
          />
          <div className="p-5 space-y-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">Folder</span>
              <Select
                aria-label="Move to folder"
                value={moveFolderId ?? ""}
                onChange={(e) => setMoveFolderId(e.target.value === "" ? null : e.target.value)}
                className="w-full"
              >
                <option value="">Backups (root)</option>
                {moveOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setMoveTarget(null)} disabled={mutating}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={() => void confirmMove()} disabled={mutating}>
                {mutating ? "Moving…" : "Move"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {newFolderOpen && (
        <Modal
          className="w-[420px] max-w-full"
          onClose={mutating ? () => undefined : () => setNewFolderOpen(false)}
        >
          <ModalHeader
            title="New folder"
            onClose={mutating ? () => undefined : () => setNewFolderOpen(false)}
          />
          <div className="p-5 space-y-4">
            <Input
              label="Folder name"
              value={newFolderName}
              autoFocus
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void confirmCreateFolder()}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setNewFolderOpen(false)} disabled={mutating}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void confirmCreateFolder()}
                disabled={mutating || !newFolderName.trim()}
              >
                {mutating ? "Creating…" : "Create"}
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

      {deleteFolderTarget && (
        <ConfirmDialog
          title="Delete folder"
          destructive
          busy={mutating}
          confirmLabel="Delete folder"
          description={
            <>
              Delete “{deleteFolderTarget.name}”? Files inside are not deleted and will move to the
              folder's parent after the next sync.
            </>
          }
          onConfirm={() => void confirmDeleteFolder()}
          onClose={() => setDeleteFolderTarget(null)}
        />
      )}

      {folderRenameTarget && (
        <Modal
          className="w-[420px] max-w-full"
          onClose={mutating ? () => undefined : () => setFolderRenameTarget(null)}
        >
          <ModalHeader
            title="Rename folder"
            onClose={mutating ? () => undefined : () => setFolderRenameTarget(null)}
          />
          <div className="p-5 space-y-4">
            <Input
              label="Folder name"
              value={folderRenameValue}
              autoFocus
              onChange={(e) => setFolderRenameValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void confirmRenameFolder()}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setFolderRenameTarget(null)} disabled={mutating}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void confirmRenameFolder()}
                disabled={mutating || !folderRenameValue.trim()}
              >
                {mutating ? "Saving…" : "Rename"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {folderPropsTarget && (
        <FolderPropertiesModal
          folder={folderPropsTarget}
          summary={folderContents(folderPropsTarget.folderId, folders, files)}
          parentName={
            folderPropsTarget.parentFolderId
              ? folderById.get(folderPropsTarget.parentFolderId)?.name ?? null
              : null
          }
          onClose={() => setFolderPropsTarget(null)}
        />
      )}
    </div>
  );
}

/** Read-only metadata panel for a folder: location, size, counts, timestamps. */
function FolderPropertiesModal({
  folder,
  summary,
  parentName,
  onClose,
}: {
  folder: FolderView;
  summary: { bytes: number; files: number; folders: number };
  parentName: string | null;
  onClose: () => void;
}) {
  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: "Name", value: folder.name },
    { label: "Type", value: "Folder" },
    { label: "Location", value: parentName ?? "Backups (root)" },
    {
      label: "Size",
      value: summary.files === 0 ? "Empty" : formatBytes(summary.bytes),
    },
    {
      label: "Contents",
      value: `${summary.files} file${summary.files === 1 ? "" : "s"}, ${
        summary.folders
      } subfolder${summary.folders === 1 ? "" : "s"}`,
    },
    { label: "Created", value: new Date(folder.createdAt).toLocaleString() },
    { label: "Modified", value: new Date(folder.updatedAt).toLocaleString() },
    { label: "Folder ID", value: folder.folderId, mono: true },
  ];
  return (
    <Modal className="w-[460px] max-w-full" onClose={onClose}>
      <ModalHeader title="Properties" onClose={onClose} />
      <div className="p-5 space-y-4">
        <div className="flex flex-col items-center gap-2">
          <Icon name="folder" size={44} className="text-accent" />
          <span className="text-sm font-medium text-foreground text-center break-all">{folder.name}</span>
        </div>
        <dl className="border border-border rounded-xl divide-y divide-border overflow-hidden">
          {rows.map((row) => (
            <div key={row.label} className="flex items-start gap-3 px-4 py-2.5">
              <dt className="w-24 shrink-0 text-xs text-muted-foreground">{row.label}</dt>
              <dd
                className={`flex-1 min-w-0 text-xs text-foreground break-all ${
                  row.mono ? "font-mono" : ""
                }`}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
