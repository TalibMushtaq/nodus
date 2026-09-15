# Phase 18 Security Review

A static review pass over the code as of 2026-09-15, answering the two Phase 18
questions: does the Relay ever see plaintext file keys or shard contents, and do
revoked devices lose access without a full account key rotation? Findings are
backed by file references; this is a code review, not a penetration test.

## 1. The Relay never sees plaintext file keys or shard contents

**Shard contents are ciphertext end to end.** A file is split into shards,
each shard is AES-256-GCM encrypted with the file's FEK, and the uploaded blob
is `nonce||ciphertext` (`packEncryptedShard`, `@repo/core`). The Relay's Path C
handler writes the request body to its buffer verbatim — it checks length and
the client-declared BLAKE3 hash of the *ciphertext*, never decrypts
(`services/relay/internal/handler/buffer_upload.go`). WebRTC paths (A/B) move the
same ciphertext shard bytes over the data channel; the Relay, when it carries
signaling only, sees SDP/ICE and never the channel
(`packages/webrtc-transport`, `services/relay/internal/handler/webrtc.go`). The
final storage object is content-addressed by the ciphertext hash; the Rust node
verifies that hash and stores the bytes unchanged
(`services/storage-node/src/webrtc/session.rs`).

**File keys never reach the Relay in plaintext.** The FEK is generated
client-side (`generateFileEncryptionKey`) and persisted locally. To share a file
the uploading device seals the FEK for each recipient's X25519 key (derived from
their Ed25519 identity) and publishes an opaque `encrypted_key` envelope
(`packages/sdk/src/envelopes/envelopes.ts`). The Relay stores only that opaque
string in `key_envelopes` / `folder_key_envelopes`
(`services/relay/internal/handler/sync.go` projection) and serves it back
verbatim. It cannot open a FEK, so it cannot decrypt a name or a shard.

**The account password/session never grants key access.** Account auth is an
opaque server-side session (`auth/session.go`); the session identifies the
account but is not an encryption key. Compromising the Relay DB yields hashes of
sessions and passwords, ciphertext shards, and opaque envelopes — not plaintext.

## 2. Revoked devices lose access without rotating every file key

A device is revoked by `DELETE /devices/{id}`, which marks it `REVOKED`,
revokes its sessions, and deletes both its file-key and folder-key envelopes
(`services/relay/internal/handler/device.go`). With the envelope gone, the
revoked device can no longer unwrap any FEK it did not already hold locally, so
newly shared files are unreadable to it. This is the ADR-0001 model: revocation
removes *future* distribution without re-encrypting every file, at the accepted
cost that a device revoked after it already cached a FEK retains that key.

The Rust Storage Node applies the same rule: node-side projection removes
envelopes on revocation, and a revoked device's challenge-response fails
(`services/storage-node/src`).

## Residual risks (accepted, v1)

- **LAN listener is plain HTTP.** Mitigated by single-use, TTL-bounded,
  device-bound tokens and Ed25519 challenge-response, not transport encryption
  (`docs/security/local-endpoints.md`).
- **A revoked device that cached a FEK keeps that file.** Rotation of every key
  is out of scope per ADR-0001; users can re-upload or delete the file.
- **Node bootstrap code is a bearer credential for ~15 minutes.** Hashed at
  rest, single-use, rate-limited, HTTPS-only (`docs/security/bootstrap-pairing.md`).
- **Recovery phrase is stored on the device** in the same local store as FEKs
  (IndexedDB / SQLite); the device is the trust boundary (ADR-0002).

## Follow-ups

- The open item to move the device private key to a non-exportable WebCrypto
  Ed25519 handle interacts with the envelope design: opening a FEK envelope
  requires deriving X25519 from the Ed25519 private seed (`ed25519PrivateToX25519`),
  which a non-extractable key cannot provide. Doing this properly means giving
  the device a separate X25519 encryption keypair (non-extractable), publishing
  its public key to the Relay, and sealing to it directly — a protocol change
  spanning Relay, Rust node, and both clients. Track as its own ADR rather than
  a drive-by change.
