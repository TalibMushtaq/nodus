//! Device-identity persistence shared by web and native.
//!
//! The Ed25519 keypair itself lives in `@repo/relay-client`; this module only
//! owns where it is kept, which is the one part that differs per platform
//! (localStorage vs. the OS keychain). The private key never leaves the device.

import { createDeviceIdentity, type StoredDeviceIdentity } from "@repo/relay-client";
import type { SecureStore } from "./adapters.js";

/** Storage key for the device identity — must stay stable across releases. */
export const DEVICE_IDENTITY_KEY = "nodus.device.identity";

/**
 * Structural check for a persisted identity. Exported so synchronous platform
 * stores (the web's localStorage) share the exact validation the async path
 * uses instead of re-implementing their own.
 */
export function isStoredDeviceIdentity(value: unknown): value is StoredDeviceIdentity {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.device_id === "string" &&
    identity.device_id.length > 0 &&
    typeof identity.public_key === "string" &&
    identity.public_key.length > 0 &&
    typeof identity.private_key === "string" &&
    identity.private_key.length > 0
  );
}

/**
 * Load the persisted device identity, generating and storing one on first use.
 * A corrupt record is replaced rather than surfaced: identity loss costs the
 * user a re-pair, whereas a parse error would brick the app on launch.
 */
export async function getOrCreateDeviceIdentity(store: SecureStore): Promise<StoredDeviceIdentity> {
  const raw = await store.get(DEVICE_IDENTITY_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isStoredDeviceIdentity(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through and regenerate.
    }
  }
  const fresh = createDeviceIdentity();
  await store.set(DEVICE_IDENTITY_KEY, JSON.stringify(fresh));
  return fresh;
}
