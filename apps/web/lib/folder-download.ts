// Build a ZIP of a folder's contents for download.
//
// Files are fetched and decrypted with the same per-file path as a normal
// download, then packed into one archive. Subfolders are included recursively
// with their names as path prefixes; files that are not yet stored on a node
// (`downloadable` false) are skipped and reported rather than failing the whole
// archive.

import type { FileEntryView } from "./file-view";
import type { FolderView } from "./use-files";
import { downloadFile, type DownloadDeps } from "./download";
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

export interface FolderArchive {
  data: Uint8Array;
  fileName: string;
  fileCount: number;
  /** Names of files that were not downloadable and were left out. */
  skipped: string[];
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
  const skipped: string[] = [];
  let bytes = 0;
  let completed = 0;

  for (const item of collected) {
    options.onProgress?.(completed, collected.length);
    const file = item.file;
    if (!file.downloadable || file.latestVersionNumber == null || file.shardCount == null) {
      skipped.push(file.name);
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
    } catch {
      // One unreachable file must not abort the archive.
      skipped.push(file.name);
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
