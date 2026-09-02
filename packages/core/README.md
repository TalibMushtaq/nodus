# @repo/core

Pure domain logic for Nodus, shared by the web and mobile clients.

## Current scope (Phase 3)

- Domain types: `FileId`, `ShardIndex`, `Shard`, `ShardMetadata`, `EncryptedShard`, `KeyEnvelope`
- 8 MB shard splitting (`splitIntoShards`)
- Shard reconstruction (`reconstructFromShards`)
- `SHARD_SIZE_BYTES` constant
- AES-256-GCM shard encryption/decryption
- BLAKE3 shard integrity hashing (operates on **ciphertext**, not plaintext)
- File Encryption Key (FEK) generation
- Envelope encryption (wrap FEK for a recipient using X25519 + HKDF + AES-256-GCM)
- Shard metadata construction (`shardMetadataFromEncryptedShard`)

All functions operate on `Uint8Array` only — no `Buffer`, no streams, no
browser/Node/RN-specific globals. This package has **no** React, Next.js,
Expo, or React Native dependencies.

## Crypto library strategy

Pure-JS implementations only, no native modules, no platform-conditional
code paths:

- `@noble/ciphers` — AES-256-GCM
- `@noble/hashes` — BLAKE3, HKDF, SHA-256, randomBytes
- `@noble/curves` — X25519 (ECDH for envelope construction)

These are audited, dependency-free, and behave identically across Node,
browser, and React Native.

## Crypto details

### BLAKE3 hashes the ciphertext, not the plaintext

`hashShard(data)` expects the complete encrypted ciphertext (i.e.,
`EncryptedShard.ciphertext`), NOT plaintext `Shard.data`. This lets
the Rust storage node (Phase 6) verify shard integrity via reconciliation
without ever touching plaintext or the File Encryption Key.

### AES-256-GCM tag placement

`@noble/ciphers` GCM appends the 16-byte authentication tag to the
ciphertext output. `EncryptedShard.ciphertext` includes the tag — it
is NOT stored separately. `decryptShard` throws a distinct error on
authentication failure (tampered ciphertext or wrong key).

### Envelope construction

`sealFekForRecipient` / `openFekEnvelope` use an anonymous sealed-box
pattern:

1. Ephemeral X25519 keypair per envelope
2. ECDH with recipient's static public key
3. HKDF (SHA-256) with info string `"nodus-fek-envelope-v1"`
4. AES-256-GCM encrypts the FEK under the derived symmetric key

Sender authenticity is not a goal — the threat model is "Relay never
sees plaintext keys," not "recipient can verify who wrapped this."

## Cross-language contract (Rust must match)

The Rust storage node (Phase 5+) must produce/consume byte-identical
formats:

- **AES-256-GCM nonce**: 12 bytes (random, per shard)
- **GCM auth tag**: 16 bytes, appended to ciphertext (not separate)
- **BLAKE3 hash**: 32-byte digest, hex-encoded to 64 lowercase hex chars
- **X25519 keys**: 32 bytes (public and secret)

Do not leave this cross-language contract implicit — any format change
must be coordinated between TypeScript and Rust implementations.

## Tests

```sh
pnpm --filter core test
```
