/**
 * SecureStore-backed persistence for the mobile pairing client.
 *
 * The web app uses IndexedDB/localStorage; on mobile the equivalent durable
 * store is the OS keychain/keystore via expo-secure-store. We persist exactly
 * two things:
 *
 *  - the device's Ed25519 identity (private key never leaves the device),
 *  - the list of nodes this device has paired with.
 */

import * as SecureStore from "expo-secure-store";

import {
  createDeviceIdentity,
  type StoredDeviceIdentity,
} from "@repo/relay-client/device-identity";

const DEVICE_KEY = "nodus.device.identity";
const TRUSTED_KEY = "nodus.trusted_nodes";

/** A storage node this device has established trust with. */
export interface TrustedNode {
  node_id: string;
  /** Last-known LAN host (IP/hostname) — probes should fall back to a scan. */
  host: string;
  /** Account id on the relay; "local_push" for the offline fast-path. */
  account_id: string;
  device_id: string;
  paired_at: string;
}

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

export async function getTrustedNodes(): Promise<TrustedNode[]> {
  const raw = await SecureStore.getItemAsync(TRUSTED_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as TrustedNode[];
  } catch {
    // Ignore corrupt data; treat as an empty list.
    return [];
  }
}

/** Append (node_id, host) — one backup host per node_id wins. */
export async function addTrustedNode(node: TrustedNode): Promise<void> {
  const nodes = await getTrustedNodes();
  const next = nodes.filter((n) => n.node_id !== node.node_id);
  next.push(node);
  await SecureStore.setItemAsync(TRUSTED_KEY, JSON.stringify(next));
}