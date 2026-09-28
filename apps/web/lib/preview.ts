"use client";

import { useEffect, useState } from "react";
import type { DevicePublicIdentity, DeviceSigner } from "@repo/sdk";

import { browserDownloadDeps, downloadFile } from "./download";
import type { FileEntryView } from "./file-view";
import { useAuth } from "../providers/auth-provider";

// Image previews for the Files ("Backups") UI. Because content is end-to-end
// encrypted, there is no server-side thumbnail to point an <img> at: the only
// way to show a real preview is to download and decrypt the file. That is
// expensive, so previews are best-effort and bounded — only known image
// extensions, only under a size cap, at most a couple of downloads at a time,
// and every result is cached for the session (object URL) so scrolling and
// re-renders do not re-fetch.

// Image preview extensions. SVG is deliberately excluded: a decrypted SVG
// rendered from a blob: URL can carry <script>/<foreignObject>, and the blob
// inherits this app's origin, so opening the URL directly would run attacker
// script with access to local storage. SVG files remain downloadable; they just
// get no inline preview.
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
]);

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
};

/** Plain extension test — deliberately cheap so it can run during render. */
export function isImageFileName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Above this, downloading a preview would cost more than it is worth. */
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
/** Keep the session object-URL cache from growing without bound. */
const MAX_CACHED_PREVIEWS = 50;
/** Parallel preview downloads; avoids flooding the connection on a photo grid. */
const MAX_CONCURRENT = 2;

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
let active = 0;
const waiters: Array<() => void> = [];
// Bumped by `revokeAllPreviews`. A preview download captures it before fetching
// and refuses to cache its URL if the epoch moved (logout/revocation happened
// mid-flight), so a resolved decrypted URL cannot resurrect after the wipe.
let epoch = 0;
// Components holding a preview URL for a key that later gets evicted/revoked.
// Notified so they can drop the now-dead URL instead of rendering a broken img.
const evictionListeners = new Set<(key: string) => void>();

/** Subscribe to cache evictions/revocation; returns an unsubscribe. */
export function onPreviewEvicted(listener: (key: string) => void): () => void {
  evictionListeners.add(listener);
  return () => {
    evictionListeners.delete(listener);
  };
}

function notifyEvicted(key: string): void {
  for (const listener of evictionListeners) listener(key);
}

async function acquire(): Promise<void> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  waiters.shift()?.();
}

function previewKey(file: Pick<FileEntryView, "fileId" | "versionHash" | "latestVersionNumber">): string {
  return `${file.fileId}:${file.versionHash ?? file.latestVersionNumber ?? "0"}`;
}

/** Cache an object URL, revoking the oldest once the cap is exceeded. */
function remember(key: string, url: string): void {
  cache.set(key, url);
  while (cache.size > MAX_CACHED_PREVIEWS) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    const oldUrl = cache.get(oldest);
    cache.delete(oldest);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    // Tell any mounted component still pointing at this URL to drop it.
    notifyEvicted(oldest);
  }
}

export function getCachedPreview(file: FileEntryView): string | null {
  return cache.get(previewKey(file)) ?? null;
}

/**
 * Revoke every cached preview URL and drop the cache. Call on logout so a
 * shared browser does not retain decrypted image data (and its object URLs) for
 * the signed-out account.
 */
export function revokeAllPreviews(): void {
  epoch += 1;
  const keys = [...cache.keys()];
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
  inflight.clear();
  for (const key of keys) notifyEvicted(key);
}

/** Download + decrypt an image and cache its object URL. Never rejects. */
export async function loadImagePreview(
  file: FileEntryView,
  device: DevicePublicIdentity,
  signer: DeviceSigner,
): Promise<string | null> {
  if (!isImageFileName(file.name)) return null;
  if ((file.sizeBytes ?? 0) > MAX_PREVIEW_BYTES) return null;
  if (file.latestVersionNumber == null || file.shardCount == null) return null;
  const key = previewKey(file);
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const taskEpoch = epoch;
    await acquire();
    try {
      const result = await downloadFile({
        fileId: file.fileId,
        versionNumber: file.latestVersionNumber!,
        shardCount: file.shardCount!,
        encryptedName: file.encryptedName,
        expectedVersionHash: file.versionHash,
        deps: browserDownloadDeps(device, signer),
      });
      const ext = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
      const blob = new Blob([result.data as unknown as BlobPart], {
        type: IMAGE_MIME[ext] ?? "application/octet-stream",
      });
      const url = URL.createObjectURL(blob);
      // A logout/revocation that landed while this was downloading must win:
      // never re-cache (or hand back) decrypted bytes for a signed-out account.
      if (epoch !== taskEpoch) {
        URL.revokeObjectURL(url);
        return null;
      }
      remember(key, url);
      return url;
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

/**
 * Resolve a preview URL for a file, loading it lazily. Returns the cached URL
 * immediately on re-mounts; `null` until a preview exists (or when the file is
 * not an eligible image).
 */
export function useImagePreview(file: FileEntryView, enabled = true): string | null {
  const { device, signer } = useAuth();
  const [url, setUrl] = useState<string | null>(() => (enabled ? getCachedPreview(file) : null));

  useEffect(() => {
    if (!enabled || !device || !signer || !isImageFileName(file.name)) return;
    let cancelled = false;
    // Resolves synchronously from cache when present, so the async setState
    // below is a no-op in that case (no re-fetch, no flicker).
    void loadImagePreview(file, device, signer).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
    // Depend on the fields that identify the bytes, not the object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, device, signer, file.fileId, file.versionHash, file.name]);

  // Drop a URL the cache later evicted, so the tile shows its placeholder
  // rather than a broken image.
  useEffect(() => {
    return onPreviewEvicted((key) => {
      if (key === previewKey(file)) setUrl((current) => (current ? null : current));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.fileId, file.versionHash, file.latestVersionNumber]);

  return url;
}
