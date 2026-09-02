import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import type { EncryptedShard, KeyEnvelope, Shard } from "./types.js";

const HKDF_INFO = new TextEncoder().encode("nodus-fek-envelope-v1");

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
