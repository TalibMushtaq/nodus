"use client";

// Local (in-tab) browser notifications.
//
// Complements the Relay's Web Push: Web Push reaches a closed tab, but it
// depends on VAPID credentials and a PushManager subscription. When those are
// unavailable — or the app is open and the event originates on this device —
// this module shows a Notification directly through the service worker.
//
// State lives in a module singleton (the same pattern as `presence-bridge`) so
// non-React callers (the transfer log, the node-status poll) can notify without
// threading a context through every layer. A small provider keeps it in sync
// with the user's preferences and push-subscription state.

import { DEFAULT_PREFERENCES, type NotificationPreferences } from "./preferences";

/** Categories a local notification can belong to. */
export type LocalNotificationCategory =
  | "transfers"
  | "conflicts"
  | "device_offline"
  | "sync_complete";

export interface LocalNotificationInput {
  title: string;
  body: string;
}

/** Where a click should land, per category (also used by the service worker). */
export const CATEGORY_ROUTES: Record<LocalNotificationCategory, string> = {
  transfers: "/downloads",
  conflicts: "/conflicts",
  device_offline: "/devices",
  sync_complete: "/files",
};

/** Maps a category to the preference that gates it. */
const CATEGORY_PREF: Record<LocalNotificationCategory, keyof NotificationPreferences> = {
  transfers: "notifyTransfers",
  conflicts: "notifyConflicts",
  device_offline: "notifyNodeOffline",
  sync_complete: "notifySyncComplete",
};

interface LocalNotificationConfig {
  preferences: NotificationPreferences;
  /**
   * True when this browser holds an active Web Push subscription. When set, the
   * three server categories are left to the relay's push so the same event does
   * not surface twice; `transfers` has no push equivalent and stays local.
   */
  pushSubscribed: boolean;
}

let config: LocalNotificationConfig = {
  preferences: DEFAULT_PREFERENCES,
  pushSubscribed: false,
};

/** Update the gating state. Called by the notification provider on pref/auth changes. */
export function configureLocalNotifications(next: Partial<LocalNotificationConfig>): void {
  config = { ...config, ...next };
}

/** Restore defaults. Test-only seam so module state does not leak between cases. */
export function resetLocalNotifications(): void {
  config = { preferences: DEFAULT_PREFERENCES, pushSubscribed: false };
}

/** Fired after the Web Push subscription changes, so the provider can re-gate. */
export const PUSH_SUBSCRIPTION_EVENT = "nodus:push-subscription-changed";

/** Announce a subscription change to whoever owns the gating state. */
export function announcePushSubscriptionChange(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PUSH_SUBSCRIPTION_EVENT));
  }
}

/** Read whether this browser currently holds a Web Push subscription. */
export async function detectPushSubscribed(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    return Boolean(subscription);
  } catch {
    return false;
  }
}

/** True when this browser exposes a usable Notification API. */
export function localNotificationsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof Notification !== "undefined" &&
    typeof navigator !== "undefined"
  );
}

/** Current permission, or "unsupported" when the API is missing. */
export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!localNotificationsSupported()) return "unsupported";
  return Notification.permission;
}

/**
 * Ask for permission. Must be called from a user gesture (the Settings button);
 * browsers ignore or deny a prompt raised on load.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!localNotificationsSupported()) return "denied";
  return Notification.requestPermission();
}

/** Whether a local notification for `category` should be shown right now. */
export function isLocalNotificationEnabled(category: LocalNotificationCategory): boolean {
  if (!localNotificationsSupported()) return false;
  if (Notification.permission !== "granted") return false;
  if (!config.preferences[CATEGORY_PREF[category]]) return false;
  // Server categories defer to Web Push while a subscription is active.
  if (config.pushSubscribed && category !== "transfers") return false;
  return true;
}

/**
 * Show a notification, if the permission and preference allow it. Best-effort:
 * a browser that refuses to display it (e.g. an insecure context) must never
 * break the action that triggered it.
 */
export async function notifyLocal(
  category: LocalNotificationCategory,
  input: LocalNotificationInput,
): Promise<void> {
  if (!isLocalNotificationEnabled(category)) return;
  await displayNotification(category, CATEGORY_ROUTES[category], input);
}

/**
 * Show a one-off test alert, bypassing the category toggles (but not the
 * permission). Used by Settings so the user can confirm notifications actually
 * surface on their machine.
 */
export async function showTestNotification(): Promise<boolean> {
  if (!localNotificationsSupported() || Notification.permission !== "granted") return false;
  await displayNotification("test", "/settings", {
    title: "Nodus test alert",
    body: "Notifications are working on this browser.",
  });
  return true;
}

/**
 * Delivery prefers the service worker's `showNotification` so `sw.js`'s
 * `notificationclick` handler owns focus + routing; `new Notification` is the
 * fallback when no worker is registered.
 */
async function displayNotification(
  tag: string,
  url: string,
  { title, body }: LocalNotificationInput,
): Promise<void> {
  const options: NotificationOptions = {
    body,
    icon: "/favicon.png",
    badge: "/favicon.png",
    // Same tag replaces a prior notice in the same category instead of stacking.
    tag,
    data: { type: tag, url },
  };
  try {
    const registration = navigator.serviceWorker
      ? await navigator.serviceWorker.getRegistration()
      : undefined;
    if (registration) {
      await registration.showNotification(title, options);
      return;
    }
    new Notification(title, options);
  } catch {
    // A blocked/insecure notification surface is not a caller error.
  }
}
