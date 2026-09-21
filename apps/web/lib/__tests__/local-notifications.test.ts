import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CATEGORY_ROUTES,
  configureLocalNotifications,
  isLocalNotificationEnabled,
  localNotificationsSupported,
  notificationPermission,
  notifyLocal,
  resetLocalNotifications,
} from "../local-notifications";

// jsdom has neither Notification nor service workers, so both are stubbed here.
// The module reads them lazily at call time, so a stub installed after import
// still takes effect.

class MockNotification {
  static permission: NotificationPermission = "granted";
  static instances: MockNotification[] = [];
  static requestPermission = vi.fn(async () => "granted" as NotificationPermission);

  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    MockNotification.instances.push(this);
  }
}

function stubNotification(permission: NotificationPermission) {
  MockNotification.permission = permission;
  MockNotification.instances = [];
  vi.stubGlobal("Notification", MockNotification);
}

/** Install a service worker whose registration exposes `showNotification`. */
function stubServiceWorker() {
  const showNotification = vi.fn(async () => undefined);
  Object.defineProperty(window.navigator, "serviceWorker", {
    value: { getRegistration: vi.fn(async () => ({ showNotification })) },
    configurable: true,
  });
  return showNotification;
}

function clearServiceWorker() {
  Object.defineProperty(window.navigator, "serviceWorker", {
    value: undefined,
    configurable: true,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearServiceWorker();
  resetLocalNotifications();
});

describe("support and permission", () => {
  it("reports unsupported when the Notification API is absent", () => {
    vi.stubGlobal("Notification", undefined);
    expect(localNotificationsSupported()).toBe(false);
    expect(notificationPermission()).toBe("unsupported");
  });

  it("reads the browser's permission when supported", () => {
    stubNotification("denied");
    expect(localNotificationsSupported()).toBe(true);
    expect(notificationPermission()).toBe("denied");
  });
});

describe("isLocalNotificationEnabled gating", () => {
  it("is disabled without permission", () => {
    stubNotification("default");
    expect(isLocalNotificationEnabled("transfers")).toBe(false);
  });

  it("is disabled when the category preference is off", () => {
    stubNotification("granted");
    configureLocalNotifications({
      preferences: {
        notifyTransfers: false,
        notifyConflicts: true,
        notifyNodeOffline: true,
        notifySyncComplete: true,
      },
    });
    expect(isLocalNotificationEnabled("transfers")).toBe(false);
    expect(isLocalNotificationEnabled("conflicts")).toBe(true);
  });

  it("defers server categories to an active push subscription but keeps transfers", () => {
    stubNotification("granted");
    configureLocalNotifications({ pushSubscribed: true });
    expect(isLocalNotificationEnabled("transfers")).toBe(true);
    expect(isLocalNotificationEnabled("conflicts")).toBe(false);
    expect(isLocalNotificationEnabled("device_offline")).toBe(false);
    expect(isLocalNotificationEnabled("sync_complete")).toBe(false);
  });
});

describe("notifyLocal delivery", () => {
  it("shows through the service worker with a category deep link", async () => {
    stubNotification("granted");
    const showNotification = stubServiceWorker();

    await notifyLocal("conflicts", { title: "New file conflict", body: "Needs review." });

    expect(showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = showNotification.mock.calls[0] as unknown as [
      string,
      NotificationOptions,
    ];
    expect(title).toBe("New file conflict");
    expect(options.tag).toBe("conflicts");
    expect((options.data as { url: string }).url).toBe(CATEGORY_ROUTES.conflicts);
  });

  it("falls back to a bare Notification when no worker is registered", async () => {
    stubNotification("granted");
    clearServiceWorker();

    await notifyLocal("transfers", { title: "Upload complete", body: "report.pdf" });

    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0]?.title).toBe("Upload complete");
  });

  it("does nothing when the category is disabled or suppressed", async () => {
    stubNotification("granted");
    const showNotification = stubServiceWorker();
    configureLocalNotifications({ pushSubscribed: true });

    await notifyLocal("conflicts", { title: "New file conflict", body: "Needs review." });

    expect(showNotification).not.toHaveBeenCalled();
    expect(MockNotification.instances).toHaveLength(0);
  });
});
