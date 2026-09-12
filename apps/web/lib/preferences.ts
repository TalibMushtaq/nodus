"use client";

import { useCallback, useEffect, useState } from "react";

// Sync preferences for the web client. These are cosmetic/UX preferences only:
// the transfer engine does not yet read them, so they are explicitly labeled as
// stored on this device in the Settings UI. Persisting them (rather than local
// component state that reset on every navigation) at least makes the controls
// honest about surviving a reload.

export interface SyncPreferences {
  autoSync: boolean;
  maxNodes: number;
}

export const DEFAULT_PREFERENCES: SyncPreferences = { autoSync: true, maxNodes: 5 };

const STORAGE_KEY = "nodus.preferences";

function isSyncPreferences(value: unknown): value is SyncPreferences {
  if (typeof value !== "object" || value === null) return false;
  const prefs = value as Record<string, unknown>;
  return typeof prefs.autoSync === "boolean" && typeof prefs.maxNodes === "number";
}

export function loadPreferences(): SyncPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_PREFERENCES;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isSyncPreferences(parsed) ? parsed : DEFAULT_PREFERENCES;
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
