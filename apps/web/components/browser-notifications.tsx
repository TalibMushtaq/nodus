"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@repo/ui/primitives/button";

// Browser push opt-in. Subscribes this browser to Web Push and registers the
// subscription with the Relay through /api/push/*; the relay then delivers the
// same account notifications it sends to mobile.

/** Convert the VAPID public key (base64url) into the bytes PushManager wants.
 *  Backed by a plain ArrayBuffer so it satisfies `applicationServerKey`'s
 *  `BufferSource` type (a bare Uint8Array widens to ArrayBufferLike). */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const normalised = padded.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalised);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function BrowserNotifications() {
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ok =
      typeof navigator !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window;
    // Deferred out of the effect body so checking support is not a synchronous
    // setState (which can cascade a render on mount).
    const initial = setTimeout(() => setSupported(ok), 0);
    if (!ok) return () => clearTimeout(initial);

    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration failures surface when the user tries to enable.
    });
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setEnabled(Boolean(subscription)))
      .catch(() => setEnabled(false));
    return () => clearTimeout(initial);
  }, []);

  const enable = useCallback(async () => {
    const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!key) {
      setError("Browser notifications are not configured on this server.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setError("Notification permission was not granted.");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!res.ok) throw new Error("Could not register this browser");
      setEnabled(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch("/api/push/unsubscribe", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      setEnabled(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!supported) {
    return (
      <p className="text-xs text-muted-foreground px-1">
        This browser does not support push notifications.
      </p>
    );
  }

  return (
    <div className="flex items-center justify-between gap-4 px-1">
      <div>
        <p className="text-sm text-foreground">Browser notifications</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          {enabled
            ? "This browser receives conflict, node-offline, and backup-complete alerts."
            : "Get conflict, node-offline, and backup-complete alerts in this browser."}
        </p>
        {error && <p className="text-[11px] text-destructive mt-1" role="alert">{error}</p>}
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
  );
}
