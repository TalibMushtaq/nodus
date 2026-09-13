"use client";

import { useCallback, useEffect, useState } from "react";

import { listConflicts, type ConflictEntry } from "./conflicts";
import { refreshCatalog } from "./files";
import { useAuth } from "../providers/auth-provider";

/**
 * Conflict inbox data (ADR-0003). Revalidates the Relay catalog on mount, on
 * manual refresh, and on a background poll, then derives the flagged-version
 * list from the cached catalog — the same source the Files page renders.
 */
export function useConflicts(pollMs = 15_000) {
  const { device } = useAuth();
  const [conflicts, setConflicts] = useState<ConflictEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(async (): Promise<{
    rows: ConflictEntry[];
    error: string | null;
  }> => {
    if (!device) return { rows: [], error: null };
    let error: string | null = null;
    try {
      await refreshCatalog();
    } catch (err) {
      // Relay unreachable: still render whatever the cache holds.
      error = err instanceof Error ? err.message : String(err);
    }
    const rows = await listConflicts(device);
    return { rows, error };
  }, [device]);

  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    void load().then(({ rows, error }) => {
      if (cancelled) return;
      if (error) setError(error);
      setConflicts(rows);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [device, reloadToken, load]);

  // Background poll so a conflict that syncs in appears without a reload.
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void load().then(({ rows, error }) => {
        if (cancelled) return;
        if (!error) setError(null);
        setConflicts(rows);
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

  return { conflicts, loading, error, refresh };
}
