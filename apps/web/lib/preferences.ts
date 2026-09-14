"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_SHARD_SIZE_BYTES, resolveShardSize } from "@repo/core";

// Sync preferences for the web client. `autoSync`/`maxNodes` are cosmetic/UX
// preferences (the transfer engine does not read them), while `shardSizeBytes`
// *is* read by the uploader. Persisting them (rather than local component state
// that reset on every navigation) makes the controls honest about surviving a
// reload.

export interface SyncPreferences {
  autoSync: boolean;
  maxNodes: number;
  /** Plaintext bytes per shard; see @repo/core `resolveShardSize`. */
  shardSizeBytes: number;
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
};

const STORAGE_KEY = "nodus.preferences";

function isSyncPreferences(value: unknown): value is SyncPreferences {
  if (typeof value !== "object" || value === null) return false;
  const prefs = value as Record<string, unknown>;
  return typeof prefs.autoSync === "boolean" && typeof prefs.maxNodes === "number";
}

/** Fill in fields missing from an older stored record (e.g. shardSizeBytes). */
function normalizePreferences(prefs: SyncPreferences): SyncPreferences {
  return {
    autoSync: prefs.autoSync,
    maxNodes: prefs.maxNodes,
    shardSizeBytes: resolveShardSize(prefs.shardSizeBytes),
  };
}

export function loadPreferences(): SyncPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_PREFERENCES;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isSyncPreferences(parsed)
      ? normalizePreferences(parsed as SyncPreferences)
      : DEFAULT_PREFERENCES;
  } catch {
    // Corrupt entry — fall back rather than crashing Settings.
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: SyncPreferences): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate post-SSR bootstrap
    setPreferences(loadPreferences());
  }, []);

  const update = useCallback((patch: Partial<SyncPreferences>) => {
    setPreferences((previous) => {
      const next = { ...previous, ...patch };
      savePreferences(next);
      return next;
    });
  }, []);

  return { preferences, update };
}
