// Nodus push service worker.
//
// Displays account notifications delivered by the relay. Payloads are generic
// by design — file names are encrypted (ADR-0001), so the relay never sends a
// decrypted name. Tapping a notification focuses an open tab or opens Activity.

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
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow("/activity");
    }),
  );
});
