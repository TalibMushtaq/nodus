import { describe, expect, it, vi } from "vitest";
import { generateFileEncryptionKey } from "@repo/core";
import { createDeviceIdentity, identityPrivateKey, identityPublicKey } from "@repo/relay-client";

import {
  collectRecipients,
  decodeEnvelope,
  envelopeEvent,
  folderEnvelopeEvent,
  openFekFromEnvelope,
  openFolderKeyFromEnvelopes,
  sealFekForRecipientIdentity,
  sealFekForRecipients,
} from "../envelopes";

// Exercise collectRecipients without hitting the network: the catalogue
// encoding differs per recipient kind, which is the bug under test.
vi.mock("../pairing", () => ({
  listDevices: vi.fn(),
  listNodes: vi.fn(),
}));

import { listDevices, listNodes } from "../pairing";

describe("FEK envelopes", () => {
  it("round-trips a FEK sealed to a device's Ed25519 identity", () => {
    const device = createDeviceIdentity();
    const fek = generateFileEncryptionKey();

    const encoded = sealFekForRecipientIdentity(fek, identityPublicKey(device));
    // Opaque on the wire: the encoded string must not contain the FEK bytes.
    expect(encoded).not.toContain(Buffer.from(fek).toString("base64"));

    const opened = openFekFromEnvelope(encoded, identityPrivateKey(device));
    expect(Array.from(opened)).toEqual(Array.from(fek));
  });

  it("fails to open with the wrong device key", () => {
    const recipient = createDeviceIdentity();
    const attacker = createDeviceIdentity();
    const encoded = sealFekForRecipientIdentity(generateFileEncryptionKey(), identityPublicKey(recipient));
    expect(() => openFekFromEnvelope(encoded, identityPrivateKey(attacker))).toThrow(/authentication failed/);
  });

  it("encodes and decodes the envelope fields", () => {
    const device = createDeviceIdentity();
    const encoded = sealFekForRecipientIdentity(generateFileEncryptionKey(), identityPublicKey(device));
    const decoded = decodeEnvelope(encoded);
    expect(decoded.ephemeralPublicKey.length).toBe(32);
    expect(decoded.nonce.length).toBe(12);
    expect(decoded.ciphertext.length).toBeGreaterThan(0);
    expect(() => decodeEnvelope("nope")).toThrow(/unrecognized/);
  });

  it("seals for multiple recipients and builds envelope events", () => {
    const fek = generateFileEncryptionKey();
    const a = createDeviceIdentity();
    const b = createDeviceIdentity();
    const sealed = sealFekForRecipients(fek, [
      { recipientId: a.device_id, recipientKind: "device", edPublicKey: identityPublicKey(a) },
      { recipientId: b.device_id, recipientKind: "node", edPublicKey: identityPublicKey(b) },
    ]);
    expect(sealed.map((s) => s.recipient_id)).toEqual([a.device_id, b.device_id]);

    const event = envelopeEvent("device-1", 3, "file-1", sealed[0]!);
    expect(event.type).toBe("KEY_ENVELOPE_ADDED");
    expect(event.origin_sequence).toBe(3);
    expect(event.payload).toMatchObject({ file_id: "file-1", recipient_kind: "device" });
  });

  it("re-sealing for the same recipient opens with that recipient's key", () => {
    const fek = generateFileEncryptionKey();
    const recipient = createDeviceIdentity();
    const first = sealFekForRecipientIdentity(fek, identityPublicKey(recipient));
    const second = sealFekForRecipientIdentity(fek, identityPublicKey(recipient));
    // Each seal uses a fresh ephemeral key, so encodings differ but both open.
    expect(first).not.toBe(second);
    expect(Array.from(openFekFromEnvelope(first, identityPrivateKey(recipient)))).toEqual(Array.from(fek));
    expect(Array.from(openFekFromEnvelope(second, identityPrivateKey(recipient)))).toEqual(Array.from(fek));
  });

  it("builds folder key envelope events and opens them by folder id", () => {
    const fek = generateFileEncryptionKey();
    const recipient = createDeviceIdentity();
    const [sealed] = sealFekForRecipients(fek, [
      { recipientId: recipient.device_id, recipientKind: "device", edPublicKey: identityPublicKey(recipient) },
    ]);

    const event = folderEnvelopeEvent("device-1", 4, "dir-1", sealed!);
    expect(event.type).toBe("FOLDER_KEY_ENVELOPE_ADDED");
    expect(event.payload).toMatchObject({
      folder_id: "dir-1",
      recipient_id: recipient.device_id,
      recipient_kind: "device",
    });

    const opened = openFolderKeyFromEnvelopes(
      [{ folder_id: "dir-1", recipient_id: recipient.device_id, recipient_kind: "device", encrypted_key: sealed!.encrypted_key }],
      "dir-1",
      recipient.device_id,
      identityPrivateKey(recipient),
    );
    expect(Array.from(opened ?? [])).toEqual(Array.from(fek));
    // A different folder id has no matching envelope.
    expect(
      openFolderKeyFromEnvelopes(
        [{ folder_id: "dir-1", recipient_id: recipient.device_id, recipient_kind: "device", encrypted_key: sealed!.encrypted_key }],
        "dir-2",
        recipient.device_id,
        identityPrivateKey(recipient),
      ),
    ).toBeNull();
  });
});

describe("collectRecipients catalogue decoding", () => {
  it("decodes base64 device keys and hex node keys to 32 bytes", async () => {
    const otherDevice = createDeviceIdentity(); // public_key is base64
    const nodeBytes = new Uint8Array(32).fill(7);
    const nodeHex = Array.from(nodeBytes, (b) => b.toString(16).padStart(2, "0")).join("");

    vi.mocked(listDevices).mockResolvedValue([
      {
        device_id: otherDevice.device_id,
        account_id: "acct-1",
        public_key: otherDevice.public_key,
        status: "ACTIVE",
        created_at: "2026-09-12T00:00:00Z",
        revoked_at: null,
      },
    ]);
    vi.mocked(listNodes).mockResolvedValue([
      {
        node_id: "node-hex",
        account_id: "acct-1",
        public_key: nodeHex,
        capabilities: ["storage"],
        status: "ACTIVE",
        is_primary: true,
        last_seen_at: null,
        created_at: "2026-09-12T00:00:00Z",
      },
    ]);

    const self = createDeviceIdentity();
    const recipients = await collectRecipients({ deviceId: self.device_id, edPublicKey: identityPublicKey(self) });

    const node = recipients.find((r) => r.recipientKind === "node");
    expect(node?.edPublicKey).toHaveLength(32);
    expect(Array.from(node?.edPublicKey ?? [])).toEqual(Array.from(nodeBytes));

    const device = recipients.find((r) => r.recipientId === otherDevice.device_id);
    expect(device?.edPublicKey).toHaveLength(32);
    expect(Array.from(device?.edPublicKey ?? [])).toEqual(Array.from(identityPublicKey(otherDevice)));
  });
});
