import { describe, expect, it } from "vitest";
import { getOrCreateDeviceIdentity } from "../src/device.js";
import type { SecureStore } from "../src/adapters.js";

class MemorySecureStore implements SecureStore {
  private map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

describe("getOrCreateDeviceIdentity", () => {
  it("creates and persists an identity on first use, then reuses it", async () => {
    const store = new MemorySecureStore();
    const first = await getOrCreateDeviceIdentity(store);
    const second = await getOrCreateDeviceIdentity(store);
    expect(first.device_id).toBeTruthy();
    expect(second.device_id).toBe(first.device_id);
    expect(second.private_key).toBe(first.private_key);
  });

  it("regenerates when the persisted record is corrupt", async () => {
    const store = new MemorySecureStore();
    await store.set("nodus.device.identity", "{not json");
    const identity = await getOrCreateDeviceIdentity(store);
    expect(identity.device_id).toBeTruthy();
    // A subsequent read must now return the repaired record.
    const again = await getOrCreateDeviceIdentity(store);
    expect(again.device_id).toBe(identity.device_id);
  });
});
