import { describe, expect, it } from "vitest";
import { generateFileEncryptionKey } from "@repo/core";
import { createDeviceIdentity, identityPrivateKey, identityPublicKey } from "@repo/relay-client";

import {
  collectRecipients,
  decodeEncryptionPublicKey,
  openFekFromEnvelope,
  openFekFromEnvelopeX25519,
  sealFekForEncryptionKey,
  sealFekForRecipientIdentity,
  sealFekForRecipients,
} from "../src/envelopes/envelopes.js";
import {
  createEncryptionIdentity,
  encryptionPrivateKeyBytes,
  encryptionPublicKeyBytes,
} from "../src/device/encryption.js";

describe("FEK envelopes (ADR-0008)", () => {
  it("seals to a published X25519 key and opens with its private key", () => {
    const fek = generateFileEncryptionKey();
    const identity = createEncryptionIdentity();

    const sealed = sealFekForEncryptionKey(fek, encryptionPublicKeyBytes(identity));
    const opened = openFekFromEnvelopeX25519(sealed, encryptionPrivateKeyBytes(identity));

    expect(opened).toEqual(fek);
  });

  it("prefers the recipient's published X25519 key over the Ed25519 derivation", () => {
    const fek = generateFileEncryptionKey();
    const device = createDeviceIdentity();
    const identity = createEncryptionIdentity();

    // Give the recipient a decoy Ed25519 key: if sealing used it, opening with
    // the X25519 key would fail.
    const [sealed] = sealFekForRecipients(fek, [
      {
        recipientId: "dev-1",
        recipientKind: "device",
        edPublicKey: identityPublicKey(device),
        x25519PublicKey: encryptionPublicKeyBytes(identity),
      },
    ]);

    expect(sealed!.recipient_id).toBe("dev-1");
    const opened = openFekFromEnvelopeX25519(sealed!.encrypted_key, encryptionPrivateKeyBytes(identity));
    expect(opened).toEqual(fek);
  });

  it("still seals to an Ed25519 identity when no X25519 key is published", () => {
    const fek = generateFileEncryptionKey();
    const device = createDeviceIdentity();

    const sealed = sealFekForRecipientIdentity(fek, identityPublicKey(device));
    const opened = openFekFromEnvelope(sealed, identityPrivateKey(device));

    expect(opened).toEqual(fek);
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    expect(() => decodeEncryptionPublicKey(btoa("short"))).toThrow(/32 bytes/);
  });

  it("seals the self envelope to the device's X25519 key, not the Ed25519 derivation", async () => {
    const fek = generateFileEncryptionKey();
    const device = createDeviceIdentity();
    const identity = createEncryptionIdentity();

    const recipients = await collectRecipients(
      {
        deviceId: device.device_id,
        edPublicKey: identityPublicKey(device),
        x25519PublicKey: encryptionPublicKeyBytes(identity),
      },
      { listDevices: async () => [], listNodes: async () => [] },
    );
    const [self] = sealFekForRecipients(fek, recipients);

    // The self recipient must be sealed with the same standalone key the device
    // opens with. If it had used the Ed25519-derived key, the X25519 open would
    // fail GCM authentication once the local key cache is gone.
    const opened = openFekFromEnvelopeX25519(self!.encrypted_key, encryptionPrivateKeyBytes(identity));
    expect(opened).toEqual(fek);
    // And it must NOT be openable with the Ed25519-derived key.
    expect(() => openFekFromEnvelope(self!.encrypted_key, identityPrivateKey(device))).toThrow();
  });
});
