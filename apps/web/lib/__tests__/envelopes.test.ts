import { describe, expect, it, vi } from "vitest";
import { generateFileEncryptionKey } from "@repo/core";
import { createDeviceIdentity, identityPublicKey } from "@repo/relay-client";
import {
  createEncryptionIdentity,
  encryptionPrivateKeyBytes,
  encryptionPublicKeyBytes,
  sealFekForEncryptionKey,
} from "@repo/sdk";

import {
  collectRecipients,
  decodeEnvelope,
  envelopeEvent,
  folderEnvelopeEvent,
  openFekFromEnvelopeX25519,
  openFolderKeyFromEnvelopes,
  sealFekForRecipients,
} from "../envelopes";
import { getOrCreateEncryptionIdentity } from "../device";

// Exercise collectRecipients without hitting the network: the catalogue
// encoding differs per recipient kind, which is the bug under test.
vi.mock("../pairing", () => ({
  listDevices: vi.fn(),
  listNodes: vi.fn(),
}));

import { listDevices, listNodes } from "../pairing";

describe("FEK envelopes (ADR-0008)", () => {
  it("round-trips a FEK sealed to a device's X25519 encryption key", () => {
    const identity = createEncryptionIdentity();
    const fek = generateFileEncryptionKey();

    const encoded = sealFekForEncryptionKey(fek, encryptionPublicKeyBytes(identity));
    // Opaque on the wire: the encoded string must not contain the FEK bytes.
    expect(encoded).not.toContain(Buffer.from(fek).toString("base64"));

    const opened = openFekFromEnvelopeX25519(encoded, encryptionPrivateKeyBytes(identity));
    expect(Array.from(opened)).toEqual(Array.from(fek));
  });

  it("fails to open with the wrong encryption key", () => {
    const recipient = createEncryptionIdentity();
    const attacker = createEncryptionIdentity();
    const encoded = sealFekForEncryptionKey(
      generateFileEncryptionKey(),
      encryptionPublicKeyBytes(recipient),
    );
    expect(() =>
      openFekFromEnvelopeX25519(encoded, encryptionPrivateKeyBytes(attacker)),
    ).toThrow(/authentication failed/);
  });

  it("encodes and decodes the envelope fields", () => {
    const identity = createEncryptionIdentity();
    const encoded = sealFekForEncryptionKey(
      generateFileEncryptionKey(),
      encryptionPublicKeyBytes(identity),
    );
    const decoded = decodeEnvelope(encoded);
    expect(decoded.ephemeralPublicKey.length).toBe(32);
    expect(decoded.nonce.length).toBe(12);
    expect(decoded.ciphertext.length).toBeGreaterThan(0);
    expect(() => decodeEnvelope("nope")).toThrow(/unrecognized/);
  });

  it("seals for multiple recipients and builds envelope events", () => {
    const fek = generateFileEncryptionKey();
    const a = createEncryptionIdentity();
    const b = createDeviceIdentity();
    const sealed = sealFekForRecipients(fek, [
      {
        recipientId: "dev-a",
        recipientKind: "device",
        edPublicKey: new Uint8Array(32),
        x25519PublicKey: encryptionPublicKeyBytes(a),
      },
      // A node has no published X25519 key, so it keeps the Ed25519 derivation.
      { recipientId: "node-b", recipientKind: "node", edPublicKey: identityPublicKey(b) },
    ]);
    expect(sealed.map((s) => s.recipient_id)).toEqual(["dev-a", "node-b"]);

    const event = envelopeEvent("device-1", 3, "file-1", sealed[0]!);
    expect(event.type).toBe("KEY_ENVELOPE_ADDED");
    expect(event.origin_sequence).toBe(3);
    expect(event.payload).toMatchObject({ file_id: "file-1", recipient_kind: "device" });
  });

  it("builds folder key envelope events and opens them with this browser's key", () => {
    const fek = generateFileEncryptionKey();
    // The opener uses the browser's persisted encryption identity, so seal to
    // exactly that public key.
    const local = getOrCreateEncryptionIdentity();
    const [sealed] = sealFekForRecipients(fek, [
      {
        recipientId: "dev-1",
        recipientKind: "device",
        edPublicKey: new Uint8Array(32),
        x25519PublicKey: encryptionPublicKeyBytes(local),
      },
    ]);

    const event = folderEnvelopeEvent("device-1", 4, "dir-1", sealed!);
    expect(event.type).toBe("FOLDER_KEY_ENVELOPE_ADDED");
    expect(event.payload).toMatchObject({
      folder_id: "dir-1",
      recipient_id: "dev-1",
      recipient_kind: "device",
    });

    const envelopes = [
      {
        folder_id: "dir-1",
        recipient_id: "dev-1",
        recipient_kind: "device" as const,
        encrypted_key: sealed!.encrypted_key,
      },
    ];
    expect(Array.from(openFolderKeyFromEnvelopes(envelopes, "dir-1", "dev-1") ?? [])).toEqual(
      Array.from(fek),
    );
    // A different folder id has no matching envelope.
    expect(openFolderKeyFromEnvelopes(envelopes, "dir-2", "dev-1")).toBeNull();
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
    const recipients = await collectRecipients({
      deviceId: self.device_id,
      edPublicKey: identityPublicKey(self),
    });

    const node = recipients.find((r) => r.recipientKind === "node");
    expect(node?.edPublicKey).toHaveLength(32);
    expect(Array.from(node?.edPublicKey ?? [])).toEqual(Array.from(nodeBytes));

    const device = recipients.find((r) => r.recipientId === otherDevice.device_id);
    expect(device?.edPublicKey).toHaveLength(32);
    expect(Array.from(device?.edPublicKey ?? [])).toEqual(Array.from(identityPublicKey(otherDevice)));
  });
});
