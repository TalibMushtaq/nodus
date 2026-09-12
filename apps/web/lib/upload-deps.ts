// Browser wiring for the Path C uploader's injected side effects. Kept separate
// from `uploader.ts` so the e2e harness can supply file-backed equivalents
// without pulling in IndexedDB or the WebSocket provider.

import { postShard } from "./buffer";
import { getFileKey, putFileKey } from "./keys";
import { nextOriginSequence } from "./sync-state";
import {
  clearUploadProgress,
  getUploadProgress,
  markShardComplete,
  saveUploadProgress,
} from "./upload-progress";
import type { UploadDeps } from "./uploader";

/** `sendEventBatch` has no browser-free default (it needs the WS connection). */
export function browserUploadDeps(
  overrides: Pick<UploadDeps, "sendEventBatch"> & Partial<UploadDeps>,
): UploadDeps {
  return {
    postShard,
    allocateSequence: nextOriginSequence,
    putFileKey,
    getFileKey,
    saveProgress: saveUploadProgress,
    getProgress: getUploadProgress,
    markShardComplete,
    clearProgress: clearUploadProgress,
    ...overrides,
  };
}
