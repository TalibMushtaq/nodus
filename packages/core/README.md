# @repo/core

Pure domain logic for Nodus, shared by the web and mobile clients.

## Current scope (Phase 2)

- Domain types: `FileId`, `ShardIndex`, `Shard`, `ShardMetadata`
- 8 MB shard splitting (`splitIntoShards`)
- Shard reconstruction (`reconstructFromShards`)
- `SHARD_SIZE_BYTES` constant

All functions operate on `Uint8Array` only — no `Buffer`, no streams, no
browser/Node/RN-specific globals. This package has **no** React, Next.js,
Expo, or React Native dependencies.

## Explicitly NOT implemented yet

Encryption and hashing are out of scope for Phase 2:

- **AES-256-GCM** encrypt/decrypt — Phase 3
- **BLAKE3** hashing — Phase 3
- **File Encryption Key** generation/envelopes — Phase 3

Consequently, `Shard.data` is plaintext and `ShardMetadata.hash` is always
`null` in this phase. Do not assume `Shard.data` is ciphertext.

## Tests

```sh
pnpm --filter core test
```
