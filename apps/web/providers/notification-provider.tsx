"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { MessageTypes } from "@repo/protocol";

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
// session. It does three things: mirror the user's toggles into the notification
// module, register the service worker (the display surface), and watch for new
// conflicts globally — the Conflicts page only polls while it is mounted, but an
// alert must fire wherever the user happens to be.

/** File ids already alerted for, so a re-poll does not re-notify. */
const NOTIFIED_CONFLICTS_KEY = "nodus.notifiedConflicts";

function readNotifiedConflicts(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(NOTIFIED_CONFLICTS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeNotifiedConflicts(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  // Bound the set so it cannot grow forever; the oldest ids have long since been
  // resolved or acknowledged by the time they fall off.
  window.localStorage.setItem(NOTIFIED_CONFLICTS_KEY, JSON.stringify([...ids].slice(-500)));
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

  // Global conflict watcher. `CATALOG_CHANGED` is the app's existing signal that  // the Relay catalog moved; refresh it, derive the flagged set, and alert only
  // for files not seen before.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    const check = async () => {
      try {
        await refreshCatalog();
        const rows = await listConflicts(device);
        if (cancelled) return;
        const ids = rows.map((row) => row.fileId);
        const notified = readNotifiedConflicts();
        const fresh = ids.filter((id) => !notified.has(id));
        // The first pass only seeds: conflicts that predate this tab must not
        // alert on every load. Later passes alert for genuinely new ones.
        if (seededRef.current && fresh.length > 0 && isLocalNotificationEnabled("conflicts")) {
          await notifyLocal("conflicts", {
            title: fresh.length === 1 ? "New file conflict" : `${fresh.length} new file conflicts`,
            body: "A file has a conflicting copy that needs review.",
          });
        }
        for (const id of ids) notified.add(id);
        writeNotifiedConflicts(notified);
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
