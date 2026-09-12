"use client";

import { useCallback, useEffect, useState } from "react";

import { listTombstones, type TombstoneItem } from "./tombstones";

/**
 * Cached Tombstone (soft-delete) list. Revalidates against the Relay on mount
 * and on demand; on a failed refresh the previous list is kept and the error is
 * surfaced inline, matching the app's other data hooks.
 */
export function useTombstones() {
  const [items, setItems] = useState<TombstoneItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listTombstones()
      .then((rows) => {
        if (!cancelled) {
          setItems(rows);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    setReloadToken((token) => token + 1);
  }, []);

  return { items, loading, error, refresh };
}
