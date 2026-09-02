import { describe, expect, it } from "vitest";
import { x25519 } from "@noble/curves/ed25519.js";
import type { FileId, ShardIndex } from "../src/types.js";
import {
  encryptShard,
  decryptShard,
  hashShard,
  generateFileEncryptionKey,
  sealFekForRecipient,
  openFekEnvelope,
} from "../src/crypto.js";
import { shardMetadataFromEncryptedShard } from "../src/metadata.js";
import {
  splitIntoShards,
  reconstructFromShards,
} from "../src/shard.js";

const fileId = "file-test" as FileId;
const index = 0 as ShardIndex;

function bytesOf(length: number, fill = 0): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`byte mismatch at offset ${i}`);
    }
  }
}

// ── Shard encryption ────────────────────────────────────────────────

describe("encryptShard / decryptShard", () => {
  it("round-trips a 0-byte shard", () => {
    const fek = generateFileEncryptionKey();
    const shard = { fileId, index, data: bytesOf(0) };
    const encrypted = encryptShard(shard, fek);
    const decrypted = decryptShard(encrypted, fek);
    expectBytesEqual(decrypted.data, shard.data);
    expect(decrypted.fileId).toBe(fileId);
    expect(decrypted.index).toBe(index);
  });

  it("round-trips a 1-byte shard", () => {
    const fek = generateFileEncryptionKey();
    const shard = { fileId, index, data: bytesOf(1, 42) };
    const encrypted = encryptShard(shard, fek);
    const decrypted = decryptShard(encrypted, fek);
    expectBytesEqual(decrypted.data, shard.data);
  });

  it("round-trips a shard at SHARD_SIZE_BYTES", () => {
    const fek = generateFileEncryptionKey();
    const shard = { fileId, index, data: bytesOf(8 * 1024 * 1024, 7) };
    const encrypted = encryptShard(shard, fek);
    const decrypted = decryptShard(encrypted, fek);
    expectBytesEqual(decrypted.data, shard.data);
  });

  it("round-trips a shard at SHARD_SIZE_BYTES + 1", () => {
    const fek = generateFileEncryptionKey();
    const shard = { fileId, index, data: bytesOf(8 * 1024 * 1024 + 1, 3) };
    const encrypted = encryptShard(shard, fek);
    const decrypted = decryptShard(encrypted, fek);
    expectBytesEqual(decrypted.data, shard.data);
  });

  it("throws on tampered ciphertext", () => {
    const fek = generateFileEncryptionKey();
    const shard = { fileId, index, data: bytesOf(64, 9) };
    const encrypted = encryptShard(shard, fek);

    const tampered = {
      ...encrypted,
      ciphertext: new Uint8Array(encrypted.ciphertext),
    };
    // Flip a byte in the middle of the ciphertext
    const mid = Math.floor(tampered.ciphertext.length / 2);
    tampered.ciphertext[mid] = tampered.ciphertext[mid]! ^ 0xff;

    expect(() => decryptShard(tampered, fek)).toThrow(
      /authentication failed/,
    );
  });

  it("throws on tampered nonce", () => {
    const fek = generateFileEncryptionKey();
    const shard = { fileId, index, data: bytesOf(64, 9) };
    const encrypted = encryptShard(shard, fek);

    const tampered = {
      ...encrypted,
      nonce: new Uint8Array(encrypted.nonce),
    };
    tampered.nonce[0] = tampered.nonce[0]! ^ 0xff;

    expect(() => decryptShard(tampered, fek)).toThrow(
      /authentication failed/,
    );
  });

  it("throws on wrong key", () => {
    const shard = { fileId, index, data: bytesOf(64, 9) };
    const encrypted = encryptShard(shard, generateFileEncryptionKey());

    const wrongKey = generateFileEncryptionKey();
    expect(() => decryptShard(encrypted, wrongKey)).toThrow(
      /authentication failed/,
    );
  });

  it("produces different nonces and ciphertexts for the same shard data", () => {
    const fek = generateFileEncryptionKey();
    const shard = { fileId, index, data: bytesOf(128, 5) };

    const enc1 = encryptShard(shard, fek);
    const enc2 = encryptShard(shard, fek);

    // Nonces should differ (random 12 bytes — collision astronomically unlikely)
    expect(enc1.nonce).not.toEqual(enc2.nonce);
    // Ciphertexts should differ
    expect(enc1.ciphertext).not.toEqual(enc2.ciphertext);
  });
});

// ── BLAKE3 hashing ──────────────────────────────────────────────────

describe("hashShard", () => {
  it("is deterministic — same input produces the same hash", () => {
    const data = bytesOf(256, 0xab);
    const h1 = hashShard(data);
    const h2 = hashShard(data);
    expect(h1).toBe(h2);
  });

  it("produces a 64-character hex string", () => {
    const h = hashShard(bytesOf(32));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a single byte of input changes", () => {
    const base = bytesOf(256, 0);
    const h1 = hashShard(base);

    const modified = new Uint8Array(base);
    modified[128] = 1;
    const h2 = hashShard(modified);

    expect(h1).not.toBe(h2);
  });

  it("works on empty input", () => {
    const h = hashShard(new Uint8Array(0));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── FEK generation ──────────────────────────────────────────────────

describe("generateFileEncryptionKey", () => {
  it("returns 32 bytes", () => {
    const fek = generateFileEncryptionKey();
    expect(fek.length).toBe(32);
  });

  it("generates distinct keys on successive calls", () => {
    const k1 = generateFileEncryptionKey();
    const k2 = generateFileEncryptionKey();
    expect(k1).not.toEqual(k2);
  });
});

// ── Key envelopes ───────────────────────────────────────────────────

describe("sealFekForRecipient / openFekEnvelope", () => {
  it("round-trips the FEK byte-for-byte", () => {
    const fek = generateFileEncryptionKey();
    const recipient = x25519.keygen();

    const envelope = sealFekForRecipient(fek, recipient.publicKey);
    const recovered = openFekEnvelope(envelope, recipient.secretKey);

    expectBytesEqual(recovered, fek);
  });

  it("throws when opening with the wrong recipient private key", () => {
    const fek = generateFileEncryptionKey();
    const alice = x25519.keygen();
    const bob = x25519.keygen();

    const envelope = sealFekForRecipient(fek, alice.publicKey);

    expect(() => openFekEnvelope(envelope, bob.secretKey)).toThrow(
      /authentication failed/,
    );
  });

  it("throws on tampered envelope ciphertext", () => {
    const fek = generateFileEncryptionKey();
    const recipient = x25519.keygen();

    const envelope = sealFekForRecipient(fek, recipient.publicKey);
    const tampered = {
      ...envelope,
      ciphertext: new Uint8Array(envelope.ciphertext),
    };
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 0xff;

    expect(() => openFekEnvelope(tampered, recipient.secretKey)).toThrow(
      /authentication failed/,
    );
  });

  it("throws on tampered ephemeral public key", () => {
    const fek = generateFileEncryptionKey();
    const recipient = x25519.keygen();

    const envelope = sealFekForRecipient(fek, recipient.publicKey);
    const tampered = {
      ...envelope,
      ephemeralPublicKey: new Uint8Array(envelope.ephemeralPublicKey),
    };
    tampered.ephemeralPublicKey[0] = tampered.ephemeralPublicKey[0]! ^ 0xff;

    expect(() => openFekEnvelope(tampered, recipient.secretKey)).toThrow(
      /authentication failed/,
    );
  });

  it("throws on tampered envelope nonce", () => {
    const fek = generateFileEncryptionKey();
    const recipient = x25519.keygen();

    const envelope = sealFekForRecipient(fek, recipient.publicKey);
    const tampered = {
      ...envelope,
      nonce: new Uint8Array(envelope.nonce),
    };
    tampered.nonce[0] = tampered.nonce[0]! ^ 0xff;

    expect(() => openFekEnvelope(tampered, recipient.secretKey)).toThrow(
      /authentication failed/,
    );
  });
});

// ── ShardMetadata helper ────────────────────────────────────────────

describe("shardMetadataFromEncryptedShard", () => {
  it("populates the correct plaintext size", () => {
    const fek = generateFileEncryptionKey();
    const plaintextSize = 1234;
    const shard = { fileId, index, data: bytesOf(plaintextSize, 7) };
    const encrypted = encryptShard(shard, fek);

    const meta = shardMetadataFromEncryptedShard(encrypted, plaintextSize);
    expect(meta.size).toBe(plaintextSize);
  });

  it("populates fileId and index from the encrypted shard", () => {
    const fek = generateFileEncryptionKey();
    const shard = { fileId, index, data: bytesOf(100) };
    const encrypted = encryptShard(shard, fek);

    const meta = shardMetadataFromEncryptedShard(encrypted, 100);
    expect(meta.fileId).toBe(fileId);
    expect(meta.index).toBe(index);
  });

  it("populates hash from ciphertext via hashShard", () => {
    const fek = generateFileEncryptionKey();
    const shard = { fileId, index, data: bytesOf(200, 3) };
    const encrypted = encryptShard(shard, fek);

    const meta = shardMetadataFromEncryptedShard(encrypted, 200);
    expect(meta.hash).toBe(hashShard(encrypted.ciphertext));
    expect(meta.hash).not.toBeNull();
    expect(meta.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns non-null hash for finalized metadata", () => {
    const fek = generateFileEncryptionKey();
    const shard = { fileId, index, data: bytesOf(10) };
    const encrypted = encryptShard(shard, fek);

    const meta = shardMetadataFromEncryptedShard(encrypted, 10);
    // Type-level: hash is string | null; runtime must be string
    expect(typeof meta.hash).toBe("string");
    expect(meta.hash!.length).toBe(64);
  });

  it("rejects negative plaintextSize", () => {
    const fek = generateFileEncryptionKey();
    const encrypted = encryptShard(
      { fileId, index, data: bytesOf(10) },
      fek,
    );
    expect(() => shardMetadataFromEncryptedShard(encrypted, -1)).toThrow(
      /non-negative integer/,
    );
  });

  it("rejects fractional plaintextSize", () => {
    const fek = generateFileEncryptionKey();
    const encrypted = encryptShard(
      { fileId, index, data: bytesOf(10) },
      fek,
    );
    expect(() =>
      shardMetadataFromEncryptedShard(encrypted, 3.5),
    ).toThrow(/non-negative integer/);
  });

  it("rejects NaN plaintextSize", () => {
    const fek = generateFileEncryptionKey();
    const encrypted = encryptShard(
      { fileId, index, data: bytesOf(10) },
      fek,
    );
    expect(() =>
      shardMetadataFromEncryptedShard(encrypted, Number.NaN),
    ).toThrow(/non-negative integer/);
  });

  it("accepts zero plaintextSize", () => {
    const fek = generateFileEncryptionKey();
    const encrypted = encryptShard(
      { fileId, index, data: bytesOf(0) },
      fek,
    );
    const meta = shardMetadataFromEncryptedShard(encrypted, 0);
    expect(meta.size).toBe(0);
    expect(meta.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Cross-protocol integration ──────────────────────────────────────

describe("Phase 3 integration", () => {
  it("split → encrypt → hash → metadata → decrypt → reconstruct", () => {
    const fek = generateFileEncryptionKey();
    const plaintext = bytesOf(8 * 1024 * 1024 + 500, 0xab);

    // Split
    const shards = splitIntoShards(fileId, plaintext);
    expect(shards.length).toBe(2);

    // Encrypt
    const encrypted = shards.map((s) => encryptShard(s, fek));

    // Hash + metadata
    const metadata = encrypted.map((e, i) =>
      shardMetadataFromEncryptedShard(e, shards[i].data.length),
    );

    for (const m of metadata) {
      expect(m.hash).not.toBeNull();
      expect(m.hash).toMatch(/^[0-9a-f]{64}$/);
    }

    // Decrypt
    const decrypted = encrypted.map((e) => decryptShard(e, fek));

    // Reconstruct
    const original = reconstructFromShards(decrypted);
    expectBytesEqual(original, plaintext);
  });
});
