/**
 * Domain types for Nodus shards and encryption.
 *
 * Phase 2 introduced `Shard` (plaintext) and `ShardMetadata` (with `hash`
 * typed `string | null`, unpopulated in Phase 2). Phase 3 introduced
 * `EncryptedShard` (ciphertext layer) and `KeyEnvelope` (FEK wrapping).
 */

/** Opaque identifier for a logical file. Do not generate IDs in this package. */
export type FileId = string & { readonly __fileId: unique symbol };

/** 0-based position of a shard within a file's shard sequence. */
export type ShardIndex = number & { readonly __shardIndex: unique symbol };

/** A single shard: its data plus its position within the file. */
export interface Shard {
  readonly fileId: FileId;
  readonly index: ShardIndex;
  readonly data: Uint8Array;
}

/**
 * An encrypted shard: its AES-256-GCM ciphertext plus the nonce used for
 * encryption. The `ciphertext` includes the 16-byte GCM authentication tag
 * appended by `@noble/ciphers` — it is NOT separate from the ciphertext
 * bytes.
 *
 * This is the on-disk / over-the-wire representation; it never contains
 * plaintext.
 */
export interface EncryptedShard {
  readonly fileId: FileId;
  readonly index: ShardIndex;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/**
 * Metadata describing a single shard.
 *
 * - `size` is the shard's plaintext byte length.
 * - `hash` is a BLAKE3 hex digest of the encrypted ciphertext (not
 *   plaintext). It is typed `string | null` for compatibility with Phase 2
 *   intermediate states; finalized metadata produced from an
 *   `EncryptedShard` via `shardMetadataFromEncryptedShard` always has a
 *   non-null hash.
 */
export interface ShardMetadata {
  readonly fileId: FileId;
  readonly index: ShardIndex;
  readonly size: number;
  readonly hash: string | null;
}

/**
 * An anonymous sealed-box key envelope wrapping a File Encryption Key (FEK)
 * for a single recipient. The relay stores these; it never possesses the
 * plaintext FEK.
 *
 * Construction:
 * 1. Ephemeral X25519 keypair generated per envelope.
 * 2. ECDH between ephemeral secret and recipient's static public key.
 * 3. HKDF (sha256) derives a symmetric key from the shared secret.
 * 4. AES-256-GCM encrypts the FEK under that symmetric key.
 * 5. Ephemeral private key is discarded immediately.
 *
 * Recovery requires only the recipient's static X25519 private key and
 * the envelope contents.
 */
export interface KeyEnvelope {
  readonly ephemeralPublicKey: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}
