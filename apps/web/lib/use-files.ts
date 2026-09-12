"use client";

import { useCallback, useEffect, useState } from "react";
import { decryptName } from "@repo/core";
import { identityPrivateKey } from "@repo/relay-client";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import { getCachedCatalog, type CatalogEntry } from "./catalog";
import { STORE_CATALOG, idbDelete } from "./db";
import { refreshCatalog } from "./files";
import { refreshFolders } from "./folders";
import { getFileKey } from "./keys";
import { fetchAndOpenFileKey } from "./envelopes";
import { shortId } from "./format";
import { isDownloadable, fileStorageState, latestSize, toSyncStatus, type FileEntryView } from "./file-view";
import { useAuth } from "../providers/auth-provider";

export type { FileEntryView } from "./file-view";

/**
 * Decrypt a file's display name. Prefers the device's local FEK, falling back
 * to the device's Relay key envelope. Never throws: a file without a usable key
 * still renders (with a short id) instead of blanking the list.
 */
async function resolveName(entry: CatalogEntry, device: StoredDeviceIdentity): Promise<string> {
  if (!entry.encrypted_name) return shortId(entry.file_id);
  let fek = await getFileKey(entry.file_id);
  if (!fek) {
    try {
      fek = (await fetchAndOpenFileKey(entry.file_id, device.device_id, identityPrivateKey(device))) ?? undefined;
    } catch {
      fek = undefined;
    }
  }
  if (!fek) return `Encrypted · ${shortId(entry.file_id)}`;
  try {
    return decryptName(entry.encrypted_name, fek);
  } catch {
    return shortId(entry.file_id);
  }
}

async function toView(entry: CatalogEntry, device: StoredDeviceIdentity): Promise<FileEntryView> {
  return {
    fileId: entry.file_id,
    name: await resolveName(entry, device),
    sizeBytes: latestSize(entry),
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
    status: toSyncStatus(entry),
    storageState: fileStorageState(entry),
    parentFolderId: entry.parent_folder_id,
    latestVersionNumber: entry.latest_version_number,
    shardCount: entry.shard_count,
    versionHash: entry.version_hash,
    encryptedName: entry.encrypted_name,
    locations: entry.locations,
    downloadable: isDownloadable(entry),
  };
}

/**
 * Cached file catalog for the Files page. Renders from IndexedDB first and
 * revalidates against the Relay; on a failed refresh the cached copy is kept
 * and the error surfaced inline, matching the app's other data hooks.
 *
 * Revalidates on mount, manual refresh, and a silent background poll so that
 * node-driven changes appear without a reload: a file sitting in the Relay
 * buffer while the node is down flips to "stored on node" as soon as the node
 * reconnects and drains the buffer (the Relay promotes RELAY_BUFFERED →
 * NODE_STORED on the node's `verified` ack).
 */
export function useFiles(pollMs = 15_000) {
  const { device } = useAuth();
  const [files, setFiles] = useState<FileEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Pure refresh + view mapping. Returns the rendered rows plus whether the
  // Relay round-trip failed, and touches no state, so effects can consume it
  // through .then/.finally callbacks — the app's established pattern for
  // setting state from async work (see the devices page). On failure the
  // cached rows are still returned so the list never blanks out.
  const load = useCallback(async (): Promise<{ views: FileEntryView[]; error: string | null }> => {
    if (!device) return { views: [], error: null };
    let error: string | null = null;
    try {
      await Promise.all([refreshCatalog(), refreshFolders()]);
    } catch (err) {
      // Relay unreachable: keep whatever is cached rather than blanking.
      error = err instanceof Error ? err.message : String(err);
    }
    const cached = await getCachedCatalog();
    const views = await Promise.all(cached.map((entry) => toView(entry, device)));
    return { views, error };
  }, [device]);

  // Loaded on mount, after a manual `refresh`, and when the account device is
  // resolved. The spinner is owned by `refresh` (which bumps `reloadToken`);
  // this effect only sets state from the async .then/.finally callbacks, so a
  // re-run never flashes "Loading files…" over the cached list.
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    void load().then(({ views, error }) => {
      if (cancelled) return;
      if (error) setError(error);
      setFiles(views);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [device, reloadToken, load]);

  // Background poll. Mounted page stays fresh even when the current account's
  // node was offline at upload time and only just came back: re-read the
  // catalog on the same cadence as the devices page so the storage badge flips
  // from "Relay buffer" to "Synced" without a manual Refresh. A poll failure
  // is ignored (the next tick retries) but a recovered poll clears stale
  // errors so the row list can heal without touching the Refresh button.
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void load().then(({ views, error }) => {
        if (cancelled) return;
        if (!error) setError(null);
        setFiles(views);
      });
    }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [device, pollMs, load]);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    setReloadToken((token) => token + 1);
  }, []);

  /**
   * Drop one file from the local cache and list immediately. Used after a
   * delete is acknowledged so the row disappears even if a stale Relay snapshot
   * would still include it (the next full refresh reconciles anyway).
   */
  const forget = useCallback(async (fileId: string) => {
    await idbDelete(STORE_CATALOG, fileId);
    setFiles((previous) => previous.filter((file) => file.fileId !== fileId));
  }, []);

  return { files, loading, error, refresh, forget };
}
