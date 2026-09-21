"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { MessageTypes } from "@repo/protocol";

import { getCachedCatalog, type CatalogEntry } from "../lib/catalog";
import { listConflicts } from "../lib/conflicts";
import { refreshCatalog } from "../lib/files";
import {
  PUSH_SUBSCRIPTION_EVENT,
  configureLocalNotifications,
  detectPushSubscribed,
  isLocalNotificationEnabled,
  notifyLocal,
} from "../lib/local-notifications";
import { usePreferences } from "../lib/preferences";
import { useAuth } from "./auth-provider";
import { useWs } from "./ws-provider";

// Keeps local browser notifications wired to real events for the whole signed-in
// session. It mirrors the user's toggles into the notification module, registers
// the service worker (the display surface), and watches the catalog globally —
// the Conflicts page only polls while it is mounted, but an alert must fire
// wherever the user happens to be. Two catalog-derived alerts are covered:
// newly-flagged conflicts and files that finished backing up to a node.

/** File ids already alerted for, so a re-poll does not re-notify. */
const NOTIFIED_CONFLICTS_KEY = "nodus.notifiedConflicts";
/** `file_id:version` keys already alerted as backed up. */
const NOTIFIED_BACKUPS_KEY = "nodus.notifiedBackups";

function readIdSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeIdSet(key: string, ids: Set<string>): void {
  if (typeof window === "undefined") return;
  // Bound the set so it cannot grow forever; the oldest ids have long since been
  // resolved or acknowledged by the time they fall off.
  window.localStorage.setItem(key, JSON.stringify([...ids].slice(-500)));
}

/**
 * Alert for conflicts not seen before. The first pass (`seedOnly`) only records
 * what already exists: a conflict that predates this tab must not alert on every
 * load. Returns the ids so the caller can persist the union in one write.
 */
async function alertNewConflicts(rows: { fileId: string }[], seedOnly: boolean): Promise<void> {
  const ids = rows.map((row) => row.fileId);
  const notified = readIdSet(NOTIFIED_CONFLICTS_KEY);
  const fresh = ids.filter((id) => !notified.has(id));
  if (!seedOnly && fresh.length > 0 && isLocalNotificationEnabled("conflicts")) {
    await notifyLocal("conflicts", {
      title: fresh.length === 1 ? "New file conflict" : `${fresh.length} new file conflicts`,
      body: "A file has a conflicting copy that needs review.",
    });
  }
  for (const id of ids) notified.add(id);
  writeIdSet(NOTIFIED_CONFLICTS_KEY, notified);
}

/**
 * Alert for files whose latest version just reached `stored` (every shard on a
 * node). Keyed by `file_id:version` so a later re-upload of the same file alerts
 * again. Like conflicts, the first pass only seeds.
 */
async function alertNewBackups(entries: CatalogEntry[], seedOnly: boolean): Promise<void> {
  const keys = entries
    .filter((entry) => entry.storage_status === "stored" && entry.latest_version_number != null)
    .map((entry) => `${entry.file_id}:${entry.latest_version_number}`);
  const notified = readIdSet(NOTIFIED_BACKUPS_KEY);
  const fresh = keys.filter((key) => !notified.has(key));
  if (!seedOnly && fresh.length > 0 && isLocalNotificationEnabled("sync_complete")) {
    await notifyLocal("sync_complete", {
      title: fresh.length === 1 ? "Backup complete" : `${fresh.length} backups complete`,
      body: "A file finished syncing to your storage node.",
    });
  }
  for (const key of keys) notified.add(key);
  writeIdSet(NOTIFIED_BACKUPS_KEY, notified);
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { preferences } = usePreferences();
  const { device } = useAuth();
  const { on } = useWs();

  // Mirror toggles into the module that non-React callers use.
  useEffect(() => {
    configureLocalNotifications({ preferences });
  }, [preferences]);

  // Register up front so a local notification has a surface before Settings is
  // ever opened; the opt-in also registers, and repeat registration is a no-op.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration failure surfaces when the user tries to enable.
    });
  }, []);

  // Track the push subscription: while one is active the relay already delivers
  // the server categories, so local delivery for those is suppressed to avoid
  // doubles. Re-checked whenever the opt-in toggles it.
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      const subscribed = await detectPushSubscribed();
      if (!cancelled) configureLocalNotifications({ pushSubscribed: subscribed });
    };
    void sync();
    window.addEventListener(PUSH_SUBSCRIPTION_EVENT, sync);
    return () => {
      cancelled = true;
      window.removeEventListener(PUSH_SUBSCRIPTION_EVENT, sync);
    };
  }, []);

  // Catalog watcher. `CATALOG_CHANGED` is the app's existing signal that the
  // Relay catalog moved; refresh once, then derive both alert classes from the
  // same snapshot so a single change does not fetch twice.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    const check = async () => {
      try {
        await refreshCatalog();
        const [conflicts, catalog] = await Promise.all([
          listConflicts(device),
          getCachedCatalog(),
        ]);
        if (cancelled) return;
        const seedOnly = !seededRef.current;
        await alertNewConflicts(conflicts, seedOnly);
        await alertNewBackups(catalog, seedOnly);
        seededRef.current = true;
      } catch {
        // Relay/cache unavailable: retry on the next catalog change.
      }
    };
    void check();
    const off = on(MessageTypes.CATALOG_CHANGED, () => void check());
    return () => {
      cancelled = true;
      off();
    };
  }, [device, on]);

  return <>{children}</>;
}
