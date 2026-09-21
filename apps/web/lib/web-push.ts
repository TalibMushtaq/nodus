"use client";

// Web Push (VAPID) browser helpers.
//
// Wraps the PushManager + `/api/push/*` relay proxy so the Settings opt-in and
// the sign-out cleanup share one implementation. All functions are best-effort
// at the call site; the caller decides how to surface a failure.

import type { NotificationPreferences } from "./preferences";

/** True when this browser can register a service worker and subscribe to push. */
export function browserPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

/**
 * The operator's VAPID public key, or null when browser push is not configured
 * on this deployment. Inlined at build time, so it must be `NEXT_PUBLIC_`.
 */
export function vapidPublicKey(): string | null {
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  return key ? key : null;
}

/** Convert the VAPID public key (base64url) into the bytes PushManager wants.
 *  Backed by a plain ArrayBuffer so it satisfies `applicationServerKey`'s
 *  `BufferSource` type (a bare Uint8Array widens to ArrayBufferLike). */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const normalised = padded.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalised);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The categories the relay understands, projected from the local prefs. */
export function pushPrefsBody(prefs: NotificationPreferences) {
  return {
    conflicts: prefs.notifyConflicts,
    device_offline: prefs.notifyNodeOffline,
    sync_complete: prefs.notifySyncComplete,
  };
}

/** This browser's active push subscription, or null. */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!browserPushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

/** Create a push subscription. The caller must already have notification permission. */
export async function subscribeBrowserPush(vapidKey: string): Promise<PushSubscription> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey),
  });
}

/** Register (or refresh) a subscription's category opt-outs with the Relay. */
export async function registerPushSubscription(
  subscription: PushSubscription,
  prefs: NotificationPreferences,
): Promise<void> {
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...subscription.toJSON(), prefs: pushPrefsBody(prefs) }),
  });
  if (!res.ok) throw new Error("Could not register this browser");
}

/** Remove a subscription from the Relay and from this browser. */
export async function unregisterPushSubscription(
  subscription: PushSubscription,
): Promise<void> {
  await fetch("/api/push/unsubscribe", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}

/**
 * Best-effort removal of this browser's push subscription. Used on sign-out,
 * while the session cookie is still valid, so a shared browser does not keep
 * receiving the previous account's alerts. Failures are ignored on purpose:
 * sign-out must not be blocked by a network error.
 */
export async function removePushSubscriptionQuietly(): Promise<void> {
  try {
    const subscription = await getPushSubscription();
    if (subscription) await unregisterPushSubscription(subscription);
  } catch {
    // Ignore: the relay token will expire or be overwritten on next sign-in.
  }
}
