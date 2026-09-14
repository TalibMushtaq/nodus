// Build a ZIP of a folder's contents for download.
//
// Files are fetched and decrypted with the same per-file path as a normal
// download, then packed into one archive. Subfolders are included recursively
// with their names as path prefixes; files that cannot be fetched are skipped
// (with a machine-readable cause: not stored, not paired, missing key, or a
// generic failure) rather than failing the whole archive.

import type { FileEntryView } from "./file-view";
import type { FolderView } from "./use-files";
import {
  downloadFile,
  MissingEnvelopeError,
  ShardUnavailableError,
  type DownloadDeps,
} from "./download";
import { createZip, type ZipEntry } from "./zip";

/** Filesystem-hostile characters replaced so entry names stay portable. */
function safeSegment(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+$/, "").trim();
  return cleaned || "item";
}

export interface FolderArchiveFile {
  /** Archive-relative path, including any parent folder prefixes. */
  path: string;
  file: FileEntryView;
}

/**
 * Collect every file beneath `folderId` (recursively) with a zip-relative path.
 * `depth` guards against a corrupt `parent_folder_id` cycle.
 */
export function collectFolderFiles(
  folderId: string,
  folders: FolderView[],
  files: FileEntryView[],
  prefix = "",
  depth = 0,
): FolderArchiveFile[] {
  if (depth > 64) return [];
  const collected: FolderArchiveFile[] = [];
  for (const file of files) {
    if ((file.parentFolderId ?? null) === folderId) {
      collected.push({ path: `${prefix}${safeSegment(file.name)}`, file });
    }
  }
  for (const folder of folders) {
    if ((folder.parentFolderId ?? null) === folderId) {
      collected.push(
        ...collectFolderFiles(
          folder.folderId,
          folders,
          files,
          `${prefix}${safeSegment(folder.name)}/`,
          depth + 1,
        ),
      );
    }
  }
  return collected;
}

/** Insert " (n)" before the extension so duplicate sibling names stay distinct. */
function suffixedPath(path: string, n: number): string {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return `${dir}${base} (${n})`;
  return `${dir}${base.slice(0, dot)} (${n})${base.slice(dot)}`;
}

/**
 * Why one file was left out of the archive. Kept machine-readable so the UI
 * can explain each cause instead of lumping them under one vague label (a
 * file that is merely still buffered is a different situation from a browser
 * that has never paired with the node holding the bytes).
 */
export type FolderSkipKind = "not-stored" | "not-paired" | "missing-key" | "failed";

export interface FolderSkip {
  name: string;
  kind: FolderSkipKind;
  /** Underlying error message, surfaced for the "failed" kind. */
  detail?: string;
}

/** Classify a per-file download failure into the user-actionable buckets. */
export function classifySkip(error: unknown): FolderSkipKind {
  if (error instanceof MissingEnvelopeError) return "missing-key";
  // The browser deps raise ShardUnavailableError when no trusted node host is
  // recorded for a stored shard — a pairing gap, not a storage gap.
  if (error instanceof ShardUnavailableError && error.message.includes("no_trusted_host")) {
    return "not-paired";
  }
  return "failed";
}

/**
 * Turn a skip list into one human sentence grouped by cause, so the Files UI
 * explains what the user can actually act on instead of a blanket "not stored
 * on a node". `pairingNeeded` lets the caller surface a pairing CTA.
 */
export function describeFolderSkips(skips: FolderSkip[]): { message: string; pairingNeeded: boolean } {
  const byKind = (kind: FolderSkipKind) => skips.filter((skip) => skip.kind === kind).length;
  const parts: string[] = [];
  const pairingNeeded = byKind("not-paired") > 0;
  const notStored = byKind("not-stored");
  if (notStored > 0) {
    parts.push(`${notStored} file(s) still buffered — not stored on a node yet`);
  }
  if (pairingNeeded) {
    parts.push(`${byKind("not-paired")} file(s) stored on a node this browser isn't paired with`);
  }
  if (byKind("missing-key") > 0) {
    parts.push(`${byKind("missing-key")} file(s) can't be decrypted on this device (no key)`);
  }
  if (byKind("failed") > 0) {
    parts.push(`${byKind("failed")} file(s) failed for another reason`);
  }
  return { message: parts.join("; ") + ".", pairingNeeded };
}

export interface FolderArchive {
  data: Uint8Array;
  fileName: string;
  fileCount: number;
  /** Files that could not be fetched/decrypted, with the cause for each. */
  skipped: FolderSkip[];
  bytes: number;
}

export async function buildFolderZip(options: {
  folderName: string;
  folderId: string;
  folders: FolderView[];
  files: FileEntryView[];
  deps: DownloadDeps;
  onProgress?: (completed: number, total: number) => void;
}): Promise<FolderArchive> {
  const collected = collectFolderFiles(options.folderId, options.folders, options.files);
  const entries: ZipEntry[] = [];
  const skipped: FolderSkip[] = [];
  let bytes = 0;
  let completed = 0;

  for (const item of collected) {
    options.onProgress?.(completed, collected.length);
    const file = item.file;
    if (!file.downloadable || file.latestVersionNumber == null || file.shardCount == null) {
      // No shard is committed on a node yet (buffered/transferring) — a real
      // storage gap, distinct from fetch/decrypt failures below.
      skipped.push({ name: file.name, kind: "not-stored" });
      completed += 1;
      continue;
    }
    // Two siblings can legitimately share a display name; keep both.
    let path = item.path;
    let suffix = 1;
    while (entries.some((entry) => entry.path === path)) {
      path = suffixedPath(item.path, suffix);
      suffix += 1;
    }
    try {
      const result = await downloadFile({
        fileId: file.fileId,
        versionNumber: file.latestVersionNumber,
        shardCount: file.shardCount,
        encryptedName: file.encryptedName,
        expectedVersionHash: file.versionHash,
        deps: options.deps,
      });
      entries.push({ path, data: result.data });
      bytes += result.data.length;
    } catch (err) {
      // One unreachable file must not abort the archive; keep the reason so
      // the caller can tell "not stored" from "not paired" from "failed".
      skipped.push({ name: file.name, kind: classifySkip(err), detail: err instanceof Error ? err.message : String(err) });
    }
    completed += 1;
  }
  options.onProgress?.(completed, collected.length);

  return {
    data: createZip(entries),
    fileName: `${safeSegment(options.folderName)}.zip`,
    fileCount: entries.length,
    skipped,
    bytes,
  };
}

/** Trigger a browser download of raw bytes without leaking an object URL. */
export function triggerBlobDownload(data: Uint8Array, fileName: string): void {
  const blob = new Blob([data as unknown as BlobPart], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
