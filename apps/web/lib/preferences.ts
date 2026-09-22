"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SHARD_SIZE_BYTES, resolveShardSize } from "@repo/core";

// Sync preferences for the web client. `autoSync`/`maxNodes` are cosmetic/UX
// preferences (the transfer engine does not read them), while `shardSizeBytes`
// *is* read by the uploader. Persisting them (rather than local component state
// that reset on every navigation) makes the controls honest about surviving a
// reload.

/** Layout of the Files ("Backups") section. */
export type FilesView = "list" | "grid";
/** Grid tile icon scale — small/medium/large. */
export type FilesIconSize = "sm" | "md" | "lg";

/**
 * Which alerts the browser is willing to show. `notifyTransfers` is local-only
 * (upload/download outcomes); the other three mirror the Relay push categories
 * and drive both the local fallback and the relay subscription's opt-outs.
 */
export interface NotificationPreferences {
  notifyTransfers: boolean;
  notifyConflicts: boolean;
  notifyNodeOffline: boolean;
  notifySyncComplete: boolean;
}

export interface SyncPreferences extends NotificationPreferences {
  autoSync: boolean;
  maxNodes: number;
  /** Plaintext bytes per shard; see @repo/core `resolveShardSize`. */
  shardSizeBytes: number;
  /**
   * Ceiling on concurrent shard downloads (1–16). The adaptive limiter ramps
   * toward this from 2 based on measured goodput; 1 forces serial downloads.
   */
  downloadParallelMax: number;
  /** Files section layout, persisted so it survives a reload. */
  filesView: FilesView;
  /** Grid tile icon scale, persisted alongside `filesView`. */
  filesIconSize: FilesIconSize;
}

/**
 * Build-time default for the shard size. `NEXT_PUBLIC_SHARD_SIZE_BYTES` lets a
 * deployment set the default (clamped to the supported range); the Settings
 * control overrides it per device.
 */
function configuredShardSize(): number {
  const raw = process.env.NEXT_PUBLIC_SHARD_SIZE_BYTES;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? resolveShardSize(parsed)
    : DEFAULT_SHARD_SIZE_BYTES;
}

export const DEFAULT_PREFERENCES: SyncPreferences = {
  autoSync: true,
  maxNodes: 5,
  shardSizeBytes: configuredShardSize(),
  downloadParallelMax: 16,
  filesView: "list",
  filesIconSize: "md",
  // Alerts default on; local delivery still requires the browser permission.
  notifyTransfers: true,
  notifyConflicts: true,
  notifyNodeOffline: true,
  notifySyncComplete: true,
};

const STORAGE_KEY = "nodus.preferences";

function isSyncPreferences(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const prefs = value as Record<string, unknown>;
  return typeof prefs.autoSync === "boolean" && typeof prefs.maxNodes === "number";
}

function isFilesView(value: unknown): value is FilesView {
  return value === "list" || value === "grid";
}

function isFilesIconSize(value: unknown): value is FilesIconSize {
  return value === "sm" || value === "md" || value === "lg";
}

/**
 * Fill in fields missing from an older stored record (e.g. shardSizeBytes, or
 * the newer view prefs). Exported for tests: a stored record written before a
 * field existed must upgrade rather than reset to defaults.
 */
export function normalizePreferences(prefs: Partial<SyncPreferences>): SyncPreferences {
  return {
    autoSync: prefs.autoSync ?? DEFAULT_PREFERENCES.autoSync,
    maxNodes: prefs.maxNodes ?? DEFAULT_PREFERENCES.maxNodes,
    shardSizeBytes: resolveShardSize(prefs.shardSizeBytes),
    // Clamp so a hand-edited or older stored record cannot push the limiter out
    // of its supported 1–16 range.
    downloadParallelMax: Math.min(
      16,
      Math.max(1, Math.floor(prefs.downloadParallelMax ?? DEFAULT_PREFERENCES.downloadParallelMax)),
    ),
    // Unknown/omitted view fields fall back rather than leaking a bad value
    // into the render, which would leave neither list nor grid active.
    filesView: isFilesView(prefs.filesView) ? prefs.filesView : DEFAULT_PREFERENCES.filesView,
    filesIconSize: isFilesIconSize(prefs.filesIconSize)
      ? prefs.filesIconSize
      : DEFAULT_PREFERENCES.filesIconSize,
    // `?? ` (not `||`) so a stored `false` survives the migration: opting a
    // category out must not be silently flipped back on by a reload.
    notifyTransfers: prefs.notifyTransfers ?? DEFAULT_PREFERENCES.notifyTransfers,
    notifyConflicts: prefs.notifyConflicts ?? DEFAULT_PREFERENCES.notifyConflicts,
    notifyNodeOffline: prefs.notifyNodeOffline ?? DEFAULT_PREFERENCES.notifyNodeOffline,
    notifySyncComplete: prefs.notifySyncComplete ?? DEFAULT_PREFERENCES.notifySyncComplete,
  };
}

export function loadPreferences(): SyncPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_PREFERENCES;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isSyncPreferences(parsed)
      ? normalizePreferences(parsed as Partial<SyncPreferences>)
      : DEFAULT_PREFERENCES;
  } catch {
    // Corrupt entry — fall back rather than crashing Settings.
    return DEFAULT_PREFERENCES;
  }
}

/** Fired after a save so every `usePreferences()` instance stays in sync. */
export const PREFERENCES_EVENT = "nodus:preferences-changed";

export function savePreferences(preferences: SyncPreferences): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  // React state is per-instance: Settings and NotificationProvider each hold
  // their own copy. Broadcasting the record keeps an alert toggle changed in one
  // place from going stale in the other until a remount.
  window.dispatchEvent(new CustomEvent(PREFERENCES_EVENT, { detail: preferences }));
}

export function clearPreferences(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

/**
 * Sync preferences backed by localStorage. Hydrates after mount because the
 * server render has no storage, matching the theme/auth post-SSR bootstrap.
 */
export function usePreferences() {
  const [preferences, setPreferences] = useState<SyncPreferences>(DEFAULT_PREFERENCES);
  // Read-modify-write happens outside the state updater: persisting (and the
  // change broadcast) is a side effect, and React may invoke an updater during
  // render. The ref also keeps back-to-back updates from racing a re-render.
  const preferencesRef = useRef(preferences);

  useEffect(() => {
    const loaded = loadPreferences();
    preferencesRef.current = loaded;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate post-SSR bootstrap
    setPreferences(loaded);
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<SyncPreferences>).detail;
      const next = detail ?? loadPreferences();
      preferencesRef.current = next;
      setPreferences(next);
    };
    window.addEventListener(PREFERENCES_EVENT, sync);
    return () => window.removeEventListener(PREFERENCES_EVENT, sync);
  }, []);

  const update = useCallback((patch: Partial<SyncPreferences>) => {
    const next = { ...preferencesRef.current, ...patch };
    preferencesRef.current = next;
    savePreferences(next);
    setPreferences(next);
  }, []);

  return { preferences, update };
}
