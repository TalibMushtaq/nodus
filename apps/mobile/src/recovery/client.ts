// Native binding for the shared @repo/sdk recovery client (ADR-0002).
//
// Supplies the native Relay HTTP adapter, the SQLite phrase store, and the
// SQLite key store for materializing recovery-sealed file/folder keys.

import { createRecoveryClient, type RecoveryClient } from "@repo/sdk";

import { createNativeRelayHttp } from "../adapters";
import { putFileKey } from "../store/keys";
import { sqliteRecoveryStore } from "./store";

export function mobileRecoveryClient(): RecoveryClient {
  return createRecoveryClient({
    http: createNativeRelayHttp(),
    store: sqliteRecoveryStore,
    // Folder keys share the file-key table (an opaque id → 32-byte key map).
    putFileKey,
    putFolderKey: putFileKey,
  });
}
