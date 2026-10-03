// Shared translation between the transfer-manager's internal path vocabulary
// (`local_signaling`, `relay_signaling`, `buffer_relay`, `local_queue`) and the
// Activity view's stored vocabulary (`local`, `relay`, `buffered`, `queued`,
// `offline`). Kept as its own pure module — no IndexedDB or React — so the store
// can normalize records at its boundary while view selectors and unit tests
// reuse the same mapping.

import type { TransferPath } from "@repo/transfer-manager";

/**
 * How the bytes moved, in the UI's shared transfer-path vocabulary
 * (`@repo/ui` PathIndicator). Stored with the entry because it cannot be
 * reconstructed later from the catalog: a file that landed via the Relay
 * buffer looks identical to one that went local P2P once it is NODE_STORED.
 * Maps from the transfer-manager's `TransferPath` at write time.
 */
export type ActivityPath = "local" | "relay" | "buffered" | "queued" | "offline";

const ACTIVITY_PATHS: readonly ActivityPath[] = ["local", "relay", "buffered", "queued", "offline"];

/**
 * Translate the transfer-manager's internal path to the UI's PathIndicator
 * vocabulary. `local_queue` (Path D) is "queued", not "buffered": the bytes sit
 * in this device's persistent queue and have not reached the Relay buffer at
 * all. Collapsing the two made Activity claim a file was Relay-buffered while
 * the Files table (correctly) showed it as local-only.
 */
export function activityPathFromTransfer(path: TransferPath | undefined): ActivityPath | undefined {
  switch (path) {
    case "local_signaling":
      return "local";
    case "relay_signaling":
      return "relay";
    case "buffer_relay":
      return "buffered";
    case "local_queue":
      return "queued";
    default:
      return undefined;
  }
}

/**
 * Normalize the free-form `path` on a remote activity record. The protocol types
 * it as `z.string()` only, so the value depends on which client logged it: the
 * web persists the UI vocabulary directly while the mobile app persists the
 * transfer-manager vocabulary. Accept both and drop anything unrecognized so an
 * unknown key never reaches PathIndicator (which would otherwise read
 * `configs[path]` as `undefined` and crash the Activity page).
 */
export function normalizeActivityPath(path: string | null | undefined): ActivityPath | undefined {
  if (!path) return undefined;
  if ((ACTIVITY_PATHS as readonly string[]).includes(path)) return path as ActivityPath;
  return activityPathFromTransfer(path as TransferPath);
}
