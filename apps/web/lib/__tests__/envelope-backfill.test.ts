import { describe, expect, it } from "vitest";
import { createDeviceIdentity, identityPublicKey } from "@repo/relay-client";
import type { EventPayload } from "@repo/protocol";

import { backfillMissingEnvelopes, type EnvelopeBackfillDeps } from "../envelope-backfill";
import type { CatalogEntry } from "../catalog";

// `resealKeysToRecipient` only reads `file_id`/`folder_id`, so a minimal cast
// stands in for a full catalog row and keeps the test focused on targeting.
const FILE = { file_id: "file-1" } as unknown as CatalogEntry;
const FEK = new Uint8Array(32).fill(7);

function baseDeps(overrides: Partial<EnvelopeBackfillDeps>): EnvelopeBackfillDeps {
  const self = createDeviceIdentity();
  const other = createDeviceIdentity();
  return {
    deviceId: self.device_id,
    catalog: [FILE],
    folders: [],
    devices: [{ device_id: other.device_id, status: "ACTIVE" }],
    summary: [],
    recipients: [
      {
        recipientId: other.device_id,
        recipientKind: "device",
        edPublicKey: identityPublicKey(other),
      },
    ],
    resolveFileKey: async () => FEK,
    resolveFolderKey: async () => null,
    allocateSequence: async () => 1,
    sendEventBatch: async () => undefined,
    ...overrides,
  };
}

describe("backfillMissingEnvelopes", () => {
  it("re-seals keys to an active device with incomplete coverage", async () => {
    const batches: EventPayload[][] = [];
    const result = await backfillMissingEnvelopes(
      baseDeps({ sendEventBatch: async (events) => void batches.push(events) }),
    );

    expect(result).toEqual({ devices: 1, files: 1, folders: 0 });
    expect(batches.flat()).toHaveLength(1);
  });

  it("skips a device that already holds full coverage", async () => {
    let sends = 0;
    const deps = baseDeps({ sendEventBatch: async () => void (sends += 1) });
    const result = await backfillMissingEnvelopes({
      ...deps,
      summary: [
        {
          recipient_id: deps.devices[0]!.device_id,
          recipient_kind: "device",
          file_count: 1,
          folder_count: 0,
          last_updated: null,
        },
      ],
    });

    expect(result.devices).toBe(0);
    expect(sends).toBe(0);
  });

  it("never targets a revoked device", async () => {
    const deps = baseDeps({});
    const result = await backfillMissingEnvelopes({
      ...deps,
      devices: [{ device_id: deps.devices[0]!.device_id, status: "REVOKED" }],
    });

    expect(result.devices).toBe(0);
  });
});
