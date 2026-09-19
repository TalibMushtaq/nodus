// Image previews for the Files list and grid.
//
// Files are end-to-end encrypted, so there is no server-side thumbnail: the
// only way to show a real preview is to download and decrypt the image. That is
// expensive, so this is best-effort and bounded — only known image extensions,
// only under a size cap, at most a couple of downloads at a time, and each
// result is written once to the cache dir and reused for the session.

import { downloadFile, toCatalogEntry } from "@repo/sdk";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import { mobileDownloadDeps } from "../download/deps";
import { writeToCache } from "../download/save";
import type { RelayFile } from "../relay";
import { latestSize } from "./view";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "heic",
  "heif",
  "svg",
]);

/** Plain extension test — deliberately cheap so it can run during render. */
export function isImageName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

// Above this, the base64 cache write (which materializes the whole file in
// memory) costs more than a thumbnail is worth, so skip the preview.
const MAX_PREVIEW_BYTES = 12 * 1024 * 1024;
/** Parallel preview downloads; avoids flooding the connection on a photo grid. */
const MAX_CONCURRENT = 2;

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
let active = 0;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  waiters.shift()?.();
}

export function getCachedPreview(fileId: string, versionNumber: number | null): string | null {
  return cache.get(`${fileId}:${versionNumber ?? 0}`) ?? null;
}

/** Download + decrypt an image into the cache dir. Never rejects. */
export async function loadImagePreview(
  device: StoredDeviceIdentity,
  file: RelayFile,
  name: string,
): Promise<string | null> {
  if (!isImageName(name)) return null;
  const entry = toCatalogEntry(file);
  const version = entry.latest_version_number;
  if (version == null) return null;
  const size = latestSize(entry);
  if (size != null && size > MAX_PREVIEW_BYTES) return null;

  const key = `${file.file_id}:${version}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  // Prefer the kept version when a conflict was resolved, matching downloads.
  const latest =
    file.versions.find((v) => v.version_number === version) ??
    [...file.versions].sort((a, b) => b.version_number - a.version_number)[0];
  if (!latest) return null;

  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const task = (async () => {
    await acquire();
    try {
      const result = await downloadFile({
        fileId: file.file_id,
        versionNumber: latest.version_number,
        shardCount: latest.shard_count,
        encryptedName: file.encrypted_name,
        expectedVersionHash: latest.version_hash,
        deps: mobileDownloadDeps(device),
      });
      // Include the extension so the platform image decoder can sniff the type.
      const uri = await writeToCache(result.data, `preview-${file.file_id}-${version}.${ext}`);
      cache.set(key, uri);
      return uri;
    } finally {
      release();
    }
  })()
    .catch(() => null)
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, task);
  return task;
}
