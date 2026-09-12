"use client";

import { useCallback, useEffect, useState } from "react";
import type { CatalogEntry } from "./catalog";
import { getCachedCatalog } from "./catalog";
import { refreshCatalog } from "./files";

/**
 * Cached file catalog for dashboard components. Renders from IndexedDB first
 * and revalidates against the Relay; on a failed refresh the cached copy is
 * kept and the error surfaced inline, matching the app's other data hooks.
 */
export function useCatalog() {
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    refreshCatalog()
      .then(() => getCachedCatalog())
      .then((cached) => {
        if (cancelled) return;
        setEntries(cached);
        setError(null);
      })
      .catch(async (err: unknown) => {
        // Relay unreachable: fall back to whatever is cached rather than blanking.
        const cached = await getCachedCatalog();
        if (cancelled) return;
        setEntries(cached);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const refresh = useCallback(() => setReloadToken((t) => t + 1), []);

  return { entries, error, loading, refresh };
}
