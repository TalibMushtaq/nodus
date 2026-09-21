"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@repo/ui/primitives/button";
import { SettingRow } from "@repo/ui/primitives/setting-row";
import { Toggle } from "@repo/ui/primitives/toggle";

import {
  announcePushSubscriptionChange,
  localNotificationsSupported,
  notificationPermission,
  requestNotificationPermission,
  showTestNotification,
} from "../lib/local-notifications";
import { usePreferences, type NotificationPreferences } from "../lib/preferences";
import {
  browserPushSupported,
  removePushSubscriptionQuietly,
  subscribeBrowserPush,
  vapidPublicKey,
} from "../lib/web-push";

// Browser notification opt-in. Enabling requests the Notification permission
// (so in-tab alerts can show) and, when the deployment has VAPID keys, also
// subscribes this browser to Web Push so the Relay can reach it with the tab
// closed. Each category toggles independently; the three server categories are
// mirrored to the Relay as push opt-outs.

interface CategoryRow {
  key: keyof NotificationPreferences;
  label: string;
  detail: string;
}

const CATEGORY_ROWS: CategoryRow[] = [
  {
    key: "notifyTransfers",
    label: "Uploads & downloads",
    detail: "When a transfer finishes or fails, in this browser",
  },
  {
    key: "notifyConflicts",
    label: "File conflicts",
    detail: "When a file has a conflicting copy",
  },
  {
    key: "notifyNodeOffline",
    label: "Storage node offline",
    detail: "When a paired storage node stops responding",
  },
  {
    key: "notifySyncComplete",
    label: "Backup complete",
    detail: "When a file finishes syncing to a storage node",
  },
];

const ALL_OFF: NotificationPreferences = {
  notifyTransfers: false,
  notifyConflicts: false,
  notifyNodeOffline: false,
  notifySyncComplete: false,
};

const ALL_ON: NotificationPreferences = {
  notifyTransfers: true,
  notifyConflicts: true,
  notifyNodeOffline: true,
  notifySyncComplete: true,
};

export function BrowserNotifications() {
  const { preferences, update } = usePreferences();
  const [supported, setSupported] = useState(false);
  const [pushCapable, setPushCapable] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    "unsupported",
  );
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pushConfigured = vapidPublicKey() !== null;
  const granted = permission === "granted";
  const anyOn = CATEGORY_ROWS.some((row) => preferences[row.key]);
  const enabled = granted && anyOn;

  useEffect(() => {
    const ok = localNotificationsSupported();
    // Deferred out of the effect body so checking support is not a synchronous
    // setState (which can cascade a render on mount). `pushCapable` is detected
    // here rather than at render so the server/client first pass agree.
    const initial = setTimeout(() => {
      setSupported(ok);
      setPushCapable(browserPushSupported());
      setPermission(notificationPermission());
    }, 0);
    if (!ok) return () => clearTimeout(initial);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Registration failures surface when the user tries to enable.
      });
      navigator.serviceWorker.ready
        .then((registration) => registration.pushManager.getSubscription())
        .then((subscription) => setPushSubscribed(Boolean(subscription)))
        .catch(() => setPushSubscribed(false));
    }
    return () => clearTimeout(initial);
  }, []);

  // Push opt-outs are reconciled by NotificationProvider (which re-registers the
  // subscription whenever the preferences change); toggling here only updates
  // the stored preference.
  const setCategory = useCallback(
    (key: keyof NotificationPreferences, value: boolean) => {
      update({ [key]: value } as Partial<NotificationPreferences>);
      setError(null);
      setNotice(null);
    },
    [update],
  );

  const enable = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await requestNotificationPermission();
      setPermission(result);
      if (result !== "granted") {
        setError(
          "Notification permission was not granted. Allow notifications for this site in your browser, then try again.",
        );
        return;
      }
      // Turning notifications on restores every category.
      update(ALL_ON);
      // Local alerts work with permission alone; Web Push additionally needs an
      // operator-provided VAPID key and PushManager support.
      if (pushCapable && pushConfigured) {
        await subscribeBrowserPush(vapidPublicKey() as string);
        // NotificationProvider reconciles the registration and the push opt-outs.
        setPushSubscribed(true);
        announcePushSubscriptionChange();
        setNotice(
          "Notifications enabled, including alerts while this tab is closed.",
        );
      } else {
        setNotice(
          "In-browser notifications enabled. Alerts while the tab is closed need Web Push configured by the operator.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [update, pushCapable, pushConfigured]);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await removePushSubscriptionQuietly();
      setPushSubscribed(false);
      announcePushSubscriptionChange();
      update(ALL_OFF);
      setNotice("Browser notifications turned off on this browser.");
    } finally {
      setBusy(false);
    }
  }, [update]);

  const sendTest = useCallback(async () => {
    setError(null);
    setNotice(null);
    const shown = await showTestNotification();
    setNotice(shown ? "Test notification sent." : "Could not show a notification.");
  }, []);

  if (!supported) {
    return (
      <p className="text-xs text-muted-foreground px-1">
        This browser does not support notifications.
      </p>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-4 py-1">
        <div>
          <p className="text-sm text-foreground">Browser notifications</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {enabled
              ? pushSubscribed
                ? "Alerts are shown in this browser, even when the tab is closed."
                : "Alerts are shown while Nodus is open in this browser."
              : "Get alerts for transfers, conflicts, node outages, and backups."}
          </p>
        </div>
        <Button
          variant={enabled ? "secondary" : "primary"}
          size="sm"
          onClick={enabled ? () => void disable() : () => void enable()}
          disabled={busy}
        >
          {busy ? "Working…" : enabled ? "Disable" : "Enable"}
        </Button>
      </div>

      <div className="mt-1">
        {CATEGORY_ROWS.map((row) => (
          <SettingRow key={row.key} label={row.label} detail={row.detail}>
            <Toggle
              aria-label={row.label}
              checked={preferences[row.key]}
              disabled={!granted || busy}
              onChange={(value) => setCategory(row.key, value)}
            />
          </SettingRow>
        ))}
        {granted && (
          <SettingRow
            label="Test notifications"
            detail="Show one alert in this browser"
          >
            <Button variant="secondary" size="sm" onClick={() => void sendTest()}>
              Send test
            </Button>
          </SettingRow>
        )}
      </div>

      {!pushCapable && (
        <p className="text-[11px] text-muted-foreground mt-2">
          This browser cannot receive alerts while closed; in-browser alerts still work.
        </p>
      )}
      {pushCapable && !pushConfigured && (
        <p className="text-[11px] text-muted-foreground mt-2">
          Server-delivered alerts are unavailable because Web Push is not configured on this
          deployment.
        </p>
      )}
      {notice && (
        <p className="text-[11px] text-muted-foreground mt-1" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="text-[11px] text-destructive mt-1" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
