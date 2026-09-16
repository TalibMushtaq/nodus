// Web binding for the shared @repo/sdk conflict inbox (ADR-0003).
//
// The derivation lives in the SDK; this binds it to the cached catalog and the
// device's local/Relay-envelope FEK, mirroring the Files page name resolution.

import { listConflicts as sdkListConflicts } from "@repo/sdk";
import type { DevicePublicIdentity } from "@repo/sdk";

import { getCachedCatalog } from "./catalog";
import { getFileKey } from "./keys";
import { fetchAndOpenFileKey } from "./envelopes";

export type { ConflictEntry } from "@repo/sdk";

/** Cached files that have at least one `flagged` version, newest first. */
export function listConflicts(device: DevicePublicIdentity) {
  return sdkListConflicts({
    listCatalog: getCachedCatalog,
    async resolveFileKey(fileId) {
      // Prefer the locally cached FEK, then this device's Relay envelope; a
      // failure returns null so the row still renders with a short id.
      const local = await getFileKey(fileId);
      if (local) return local;
      try {
        return (await fetchAndOpenFileKey(fileId, device.device_id)) ?? null;
      } catch {
        return null;
      }
    },
  });
}
