import { gcm } from "@noble/ciphers/aes.js";
import {
  edwardsToMontgomeryPriv,
  edwardsToMontgomeryPub,
  x25519,
} from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import type { EncryptedShard, FileId, KeyEnvelope, Shard, ShardIndex } from "./types.js";

const HKDF_INFO = new TextEncoder().encode("nodus-fek-envelope-v1");

/** AES-256-GCM nonce size. The nonce is not secret but must be preserved. */
export const SHARD_NONCE_SIZE = 12;

/**
 * Serialize an encrypted shard to the bytes that are hashed, uploaded, and
 * stored: `nonce(12) || ciphertext(+tag)`.
 *
 * The separate `EncryptedShard.nonce` field would otherwise be lost the moment
 * the shard leaves the client, making the ciphertext undecryptable. The Relay,
 * Storage Node, and content-addressed object store all treat this packed blob
 * as opaque; only the client splits it again in `unpackEncryptedShard`.
 */
export function packEncryptedShard(encrypted: EncryptedShard): Uint8Array {
  const packed = new Uint8Array(encrypted.nonce.length + encrypted.ciphertext.length);
  packed.set(encrypted.nonce, 0);
  packed.set(encrypted.ciphertext, encrypted.nonce.length);
  return packed;
}

/** Reverse `packEncryptedShard`. Throws if the blob is too short to hold a nonce. */
export function unpackEncryptedShard(
  fileId: FileId,
  index: ShardIndex,
  packed: Uint8Array,
): EncryptedShard {
  if (packed.length < SHARD_NONCE_SIZE) {
    throw new Error("unpackEncryptedShard: blob is shorter than a nonce");
  }
  return {
    fileId,
    index,
    nonce: packed.slice(0, SHARD_NONCE_SIZE),
    ciphertext: packed.slice(SHARD_NONCE_SIZE),
  };
}

/**
 * Encrypt a single plaintext shard with AES-256-GCM.
 *
 * A random 12-byte nonce is generated per encryption call. The GCM
 * authentication tag (16 bytes) is appended to the ciphertext by
 * `@noble/ciphers` — it is part of `EncryptedShard.ciphertext`, not
 * stored separately.
 *
 * This function is pure and independent: no cross-shard state, so
 * shards can be encrypted in parallel.
 */
export function encryptShard(shard: Shard, fek: Uint8Array): EncryptedShard {
  const nonce = randomBytes(12);
  const ciphertext = gcm(fek, nonce).encrypt(shard.data);
  return { fileId: shard.fileId, index: shard.index, nonce, ciphertext };
}

/**
 * Decrypt an encrypted shard back to its original plaintext.
 *
 * Throws a distinct error on GCM authentication failure (tampered
 * ciphertext, wrong key, or corrupted nonce). Callers must not treat
 * a failed decryption as a generic error — the error message identifies
 * this as an authentication failure for Phase 18's security review.
 */
export function decryptShard(
  encrypted: EncryptedShard,
  fek: Uint8Array,
): Shard {
  try {
    const data = gcm(fek, encrypted.nonce).decrypt(encrypted.ciphertext);
    return { fileId: encrypted.fileId, index: encrypted.index, data };
  } catch {
    throw new Error(
      "decryptShard: authentication failed — ciphertext may be tampered or key is wrong",
    );
  }
}

/**
 * BLAKE3 integrity hash of an encrypted shard's ciphertext.
 *
 * **IMPORTANT:** `data` MUST be the complete ciphertext (i.e.,
 * `EncryptedShard.ciphertext`), NOT plaintext `Shard.data`. Hashing
 * the ciphertext lets the Rust storage node (Phase 6) verify shard
 * integrity via reconciliation without ever touching plaintext or the
 * File Encryption Key.
 *
 * Returns a 64-character lowercase hex string (BLAKE3's 32-byte
 * digest). This is a pure hash, not keyed — GCM's tag provides
 * tamper-evidence tied to the FEK; BLAKE3 here is for storage-layer
 * integrity (bit rot, transfer corruption, reconciliation).
 */
export function hashShard(data: Uint8Array): string {
  return bytesToHex(blake3(data));
}

/**
 * Generate a cryptographically random 256-bit File Encryption Key.
 *
 * One FEK per file — it is generated once and used to encrypt every
 * shard of that file (see §10 of the implementation plan). The FEK is
 * then wrapped via `sealFekForRecipient` for each authorized device
 * or storage node.
 */
export function generateFileEncryptionKey(): Uint8Array {
  return randomBytes(32);
}

/**
 * Incremental BLAKE3 hasher for a file's plaintext. A version_hash is a single
 * hash over the whole file, but the uploader must not hold a large file in
 * memory to compute it — feed each `file.slice()` chunk to `update` and call
 * `digest` once at the end.
 */
export function createPlaintextHasher(): {
  update: (chunk: Uint8Array) => void;
  digest: () => string;
} {
  const hasher = blake3.create();
  return {
    update(chunk: Uint8Array): void {
      hasher.update(chunk);
    },
    digest(): string {
      return bytesToHex(hasher.digest());
    },
  };
}

/** Version tag for the encrypted-name envelope, so the format can evolve. */
const NAME_FORMAT_VERSION = "v1";

/**
 * Encrypt a filename under its file's FEK (AES-256-GCM, random 12-byte nonce).
 * The Relay stores the returned opaque string in `files.encrypted_name`; it can
 * never read the name. Format: `v1.<hex nonce>.<hex ciphertext+tag>`.
 */
export function encryptName(name: string, fek: Uint8Array): string {
  const nonce = randomBytes(12);
  const ciphertext = gcm(fek, nonce).encrypt(new TextEncoder().encode(name));
  return `${NAME_FORMAT_VERSION}.${bytesToHex(nonce)}.${bytesToHex(ciphertext)}`;
}

/** Reverse `encryptName`. Throws on a malformed or tampered envelope. */
export function decryptName(encoded: string, fek: Uint8Array): string {
  const parts = encoded.split(".");
  if (parts.length !== 3 || parts[0] !== NAME_FORMAT_VERSION) {
    throw new Error("decryptName: unrecognized encrypted-name format");
  }
  try {
    const plaintext = gcm(fek, hexToBytes(parts[1]!)).decrypt(hexToBytes(parts[2]!));
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("decryptName: authentication failed — name may be tampered or key is wrong");
  }
}

/**
 * Convert an Ed25519 public key to its X25519 (Montgomery) equivalent.
 *
 * Nodus device/node identity is Ed25519 (signing, challenge-response), but the
 * FEK envelope primitive is X25519 (ADR-0001). Rather than maintain a second
 * keypair per device, the encryption key is derived from the identity key. Both
 * sides can compute the same conversion from public keys alone.
 */
export function ed25519PublicToX25519(edPublicKey: Uint8Array): Uint8Array {
  return edwardsToMontgomeryPub(edPublicKey);
}

/**
 * Derive the X25519 private key from an Ed25519 private seed. Callers must
 * treat the result with the same secrecy as the seed itself.
 */
export function ed25519PrivateToX25519(edPrivateSeed: Uint8Array): Uint8Array {
  return edwardsToMontgomeryPriv(edPrivateSeed);
}

/**
 * Derive the device/node encryption keypair (X25519) from an Ed25519 seed.
 * `publicKey` is what gets published so others can seal a FEK for this device.
 */
export function deriveEncryptionKeypair(edPrivateSeed: Uint8Array): {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
} {
  const privateKey = ed25519PrivateToX25519(edPrivateSeed);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/**
 * Wrap a FEK for a single recipient using an anonymous sealed-box
 * construction:
 *
 * 1. Generate an ephemeral X25519 keypair.
 * 2. ECDH between the ephemeral secret and recipient's static public key.
 * 3. HKDF (SHA-256) derives a symmetric key from the shared secret with
 *    info string `"nodus-fek-envelope-v1"`.
 * 4. AES-256-GCM encrypts the FEK under that derived key.
 * 5. The ephemeral private key is discarded immediately after use; it
 *    must never be persisted or logged.
 *
 * The ephemeral public key travels in the envelope so the recipient can
 * redo the ECDH step. Sender authenticity is not a goal — the threat
 * model is "Relay never sees plaintext keys," not "recipient can verify
 * who wrapped this."
 */
export function sealFekForRecipient(
  fek: Uint8Array,
  recipientPublicKey: Uint8Array,
): KeyEnvelope {
  const ephemeral = x25519.keygen();
  const sharedSecret = x25519.getSharedSecret(
    ephemeral.secretKey,
    recipientPublicKey,
  );
  const derivedKey = hkdf(sha256, sharedSecret, new Uint8Array(0), HKDF_INFO, 32);
  const nonce = randomBytes(12);
  const ciphertext = gcm(derivedKey, nonce).encrypt(fek);
  return {
    ephemeralPublicKey: ephemeral.publicKey,
    nonce,
    ciphertext,
  };
}

/**
 * Unwrap a FEK from a key envelope using the recipient's static
 * X25519 private key.
 *
 * Steps mirror `sealFekForRecipient`:
 * 1. ECDH between recipient's static private key and envelope's
 *    ephemeral public key.
 * 2. Same HKDF derivation to recover the symmetric key.
 * 3. AES-256-GCM decrypt the FEK.
 *
 * Throws a distinct error on authentication failure (tampered envelope
 * or wrong private key).
 */
export function openFekEnvelope(
  envelope: KeyEnvelope,
  recipientPrivateKey: Uint8Array,
): Uint8Array {
  try {
    const sharedSecret = x25519.getSharedSecret(
      recipientPrivateKey,
      envelope.ephemeralPublicKey,
    );
    const derivedKey = hkdf(sha256, sharedSecret, new Uint8Array(0), HKDF_INFO, 32);
    return gcm(derivedKey, envelope.nonce).decrypt(envelope.ciphertext);
  } catch {
    throw new Error(
      "openFekEnvelope: authentication failed — envelope may be tampered or key is wrong",
    );
  }
}
