import { describe, expect, it } from "vitest";
import { generateFileEncryptionKey } from "@repo/core";
import { createDeviceIdentity, identityPrivateKey, identityPublicKey } from "@repo/relay-client";

import {
  decodeEnvelope,
  envelopeEvent,
  openFekFromEnvelope,
  sealFekForRecipientIdentity,
  sealFekForRecipients,
} from "../envelopes";

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
});
