import { afterEach, describe, expect, it, vi } from "vitest";

import { pushPrefsBody, removePushSubscriptionQuietly, urlBase64ToUint8Array } from "../web-push";
import { DEFAULT_PREFERENCES } from "../preferences";

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window.navigator, "serviceWorker", {
    value: undefined,
    configurable: true,
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes an unpadded base64url key", () => {
    // "hello" as base64url without padding.
    expect(Array.from(urlBase64ToUint8Array("aGVsbG8"))).toEqual([104, 101, 108, 108, 111]);
  });
});

describe("pushPrefsBody", () => {
  it("maps the local toggles onto the relay's category names", () => {
    expect(
      pushPrefsBody({ ...DEFAULT_PREFERENCES, notifyConflicts: false, notifyNodeOffline: false }),
    ).toEqual({ conflicts: false, device_offline: false, sync_complete: true });
  });
});

describe("removePushSubscriptionQuietly", () => {
  function stubWorker(getSubscription: () => Promise<unknown>) {
    Object.defineProperty(window.navigator, "serviceWorker", {
      value: { ready: Promise.resolve({ pushManager: { getSubscription } }) },
      configurable: true,
    });
    vi.stubGlobal("PushManager", class {});
  }

  it("deletes the relay registration and unsubscribes the browser", async () => {
    const unsubscribe = vi.fn(async () => true);
    const subscription = { endpoint: "https://push.example/abc", unsubscribe };
    stubWorker(async () => subscription);
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await removePushSubscriptionQuietly();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/push/unsubscribe",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("swallows failures so sign-out is never blocked", async () => {
    stubWorker(async () => {
      throw new Error("no worker");
    });
    await expect(removePushSubscriptionQuietly()).resolves.toBeUndefined();
  });
});
