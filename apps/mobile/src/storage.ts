/**
 * Keychain-backed persistence for the device's long-lived identity.
 *
 * The Ed25519 private key is the only thing that must live in the OS
 * keychain/keystore (expo-secure-store); everything else durable (trusted
 * nodes, transfer queue, cached catalogue) is non-secret and lives in SQLite
 * under `src/store/`.
 */

import * as SecureStore from "expo-secure-store";

import {
  createDeviceIdentity,
  type StoredDeviceIdentity,
} from "@repo/relay-client/device-identity";
import { getOrCreateEncryptionIdentity, type StoredEncryptionIdentity } from "@repo/sdk";

import { secureStore } from "./adapters";

const DEVICE_KEY = "nodus.device.identity";

/** Load the persisted device identity, generating + storing one on first use. */
export async function loadOrCreateDevice(): Promise<StoredDeviceIdentity> {
  const raw = await SecureStore.getItemAsync(DEVICE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as StoredDeviceIdentity;
    } catch {
      // Corrupt persisted identity — fall through and regenerate.
    }
  }
  const fresh = createDeviceIdentity();
  await SecureStore.setItemAsync(DEVICE_KEY, JSON.stringify(fresh));
  return fresh;
}

/**
 * This device's X25519 encryption identity (ADR-0008), kept in the keychain
 * beside the Ed25519 signing identity. Its public half is published to the
 * Relay so senders seal envelopes to it directly.
 */
export function loadOrCreateEncryptionIdentity(): Promise<StoredEncryptionIdentity> {
  return getOrCreateEncryptionIdentity(secureStore);
}
