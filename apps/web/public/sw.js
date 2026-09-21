// Nodus push service worker.
//
// Displays account notifications delivered by the relay. Payloads are generic
// by design — file names are encrypted (ADR-0001), so the relay never sends a
// decrypted name. Tapping a notification focuses an open tab or opens the page
// that matches the alert category. Local notifications (lib/local-notifications)
// reuse this worker and send an explicit `data.url`.

// Category → deep link, mirroring CATEGORY_ROUTES in lib/local-notifications.ts.
// The relay's Web Push payloads carry only `data.type`, so the worker maps it.
const CATEGORY_ROUTES = {
  transfers: "/downloads",
  conflicts: "/conflicts",
  device_offline: "/devices",
  sync_complete: "/files",
};

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === "string" ? payload.title : "Nodus";
  const body = typeof payload.body === "string" ? payload.body : "";
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const tag = typeof data.type === "string" ? data.type : undefined;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data,
      tag,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target =
    (typeof data.url === "string" && data.url) || CATEGORY_ROUTES[data.type] || "/activity";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.focus();
          // Route the focused tab to the alert's page when it supports it; an
          // older client that cannot navigate is still focused.
          if ("navigate" in client) return client.navigate(target);
          return undefined;
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
