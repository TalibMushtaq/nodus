import { describe, it, expect, beforeEach } from "vitest";
import { getOrCreateDeviceIdentity, DEVICE_IDENTITY_KEY } from "../device";
import type { StoredDeviceIdentity } from "@repo/relay-client";

describe("getOrCreateDeviceIdentity", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("generates a new identity on first call", () => {
    const identity = getOrCreateDeviceIdentity();

    expect(identity).toBeDefined();
    expect(identity.device_id).toHaveLength(16);
    expect(identity.public_key).toBeTruthy();
    expect(identity.private_key).toBeTruthy();
  });

  it("persists identity to localStorage", () => {
    const identity = getOrCreateDeviceIdentity();

    const stored = localStorage.getItem(DEVICE_IDENTITY_KEY);
    expect(stored).toBeTruthy();

    const parsed = JSON.parse(stored!) as StoredDeviceIdentity;
    expect(parsed.device_id).toBe(identity.device_id);
    expect(parsed.public_key).toBe(identity.public_key);
    expect(parsed.private_key).toBe(identity.private_key);
  });

  it("returns existing identity from localStorage", () => {
    const first = getOrCreateDeviceIdentity();
    const second = getOrCreateDeviceIdentity();

    expect(second.device_id).toBe(first.device_id);
    expect(second.public_key).toBe(first.public_key);
    expect(second.private_key).toBe(first.private_key);
  });

  it("regenerates identity on corrupt storage", () => {
    localStorage.setItem(DEVICE_IDENTITY_KEY, "not-valid-json");

    const identity = getOrCreateDeviceIdentity();

    expect(identity).toBeDefined();
    expect(identity.device_id).toHaveLength(16);

    // Should have overwritten the corrupt data
    const stored = JSON.parse(localStorage.getItem(DEVICE_IDENTITY_KEY)!) as StoredDeviceIdentity;
    expect(stored.device_id).toBe(identity.device_id);
  });

  it("regenerates identity when stored data is incomplete", () => {
    localStorage.setItem(
      DEVICE_IDENTITY_KEY,
      JSON.stringify({ device_id: "abc" }),
    );

    const identity = getOrCreateDeviceIdentity();

    expect(identity).toBeDefined();
    expect(identity.device_id).toHaveLength(16);
    expect(identity.public_key).toBeTruthy();
    expect(identity.private_key).toBeTruthy();
  });

  it("generates unique identities on separate calls after clear", () => {
    const first = getOrCreateDeviceIdentity();
    localStorage.clear();
    const second = getOrCreateDeviceIdentity();

    expect(second.device_id).not.toBe(first.device_id);
  });
});
