"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { MessageTypes } from "@repo/protocol";

import { getCachedCatalog, type CatalogEntry } from "../lib/catalog";
import { listConflicts } from "../lib/conflicts";
import { refreshCatalog } from "../lib/files";
import {
  PUSH_SUBSCRIPTION_EVENT,
  configureLocalNotifications,
  isLocalNotificationEnabled,
  notifyLocal,
} from "../lib/local-notifications";
import { usePreferences } from "../lib/preferences";
import { getPushSubscription, registerPushSubscription } from "../lib/web-push";
import { useAuth } from "./auth-provider";
import { useWs } from "./ws-provider";

// Keeps local browser notifications wired to real events for the whole signed-in
// session. It mirrors the user's toggles into the notification module, keeps the
// Web Push registration fresh, registers the service worker (the display
// surface), and watches the catalog globally — the Conflicts page only polls
// while it is mounted, but an alert must fire wherever the user happens to be.
// Two catalog-derived alerts are covered: newly-flagged conflicts and files that
// finished backing up to a node.

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
 * load.
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
  const [pushSubscribed, setPushSubscribed] = useState(false);
  // Latest preferences for `reconcilePush`, which is invoked from non-React
  // callbacks (the push-change event / a worker message) and would otherwise
  // close over a stale value.
  const preferencesRef = useRef(preferences);
  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

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

  // (Re)confirm the Web Push subscription and refresh its registration with the
  // relay. Runs on mount, when the opt-in toggles it, and when the browser
  // rotates the subscription (`pushsubscriptionchange` forwarded by the worker).
  // Mobile refreshes its token on every session/pref change; this is the web
  // counterpart, so a rotated endpoint or a changed opt-out does not go stale.
  const reconcilePush = useCallback(async () => {
    try {
      const subscription = await getPushSubscription();
      const subscribed = Boolean(subscription);
      setPushSubscribed(subscribed);
      configureLocalNotifications({ pushSubscribed: subscribed });
      if (subscription) await registerPushSubscription(subscription, preferencesRef.current);
    } catch {
      // Best-effort: without a subscription the local channel still works.
    }
  }, []);

  useEffect(() => {
    // Deferred out of the effect body: reconcilePush sets state once the
    // subscription resolves, and a synchronous call here would cascade a render.
    const initial = setTimeout(() => void reconcilePush(), 0);
    window.addEventListener(PUSH_SUBSCRIPTION_EVENT, reconcilePush);
    return () => {
      clearTimeout(initial);
      window.removeEventListener(PUSH_SUBSCRIPTION_EVENT, reconcilePush);
    };
  }, [reconcilePush]);

  // Re-send the per-category opt-outs whenever a toggle changes on an active
  // subscription, so the relay stops (or starts) delivering that category.
  useEffect(() => {
    if (!pushSubscribed) return;
    void (async () => {
      const subscription = await getPushSubscription();
      if (subscription) await registerPushSubscription(subscription, preferences);
    })();
  }, [preferences, pushSubscribed]);

  // A browser can rotate a subscription while the tab is open; the worker has no
  // VAPID key, so it tells the app to re-subscribe + re-register.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === "pushsubscriptionchange") {
        void reconcilePush();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [reconcilePush]);

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
