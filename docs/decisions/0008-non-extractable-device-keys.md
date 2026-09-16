# ADR-0008: Non-Extractable Device Keys (Proposed)

## Status
Accepted (2026-09-15) — implemented.

- **Phase 1**: devices publish an X25519 encryption key; senders seal to it
  directly, with the Ed25519→X25519 derivation for nodes/recovery (which keep
  Ed25519 identities).
- **Phase 1b**: web and mobile generate/persist the key and publish it on
  auth/recovery/device-registration.
- **Phase 3a**: a tested non-extractable WebCrypto Ed25519 signer primitive
  (`packages/sdk/src/device/webcrypto.ts`).
- **Phase 3b (clean-slate cutover)**: the web client now creates a
  non-extractable Ed25519 `CryptoKey`, persists it in the `device_keys`
  IndexedDB store, and signs through a handle exposed by the auth provider; the
  exportable seed and its loading paths are gone, and all `identityPrivateKey`
  call sites are replaced by `signer.sign`. Envelope opening uses the separate
  X25519 encryption identity only.

### Development-only cutover
This phase was done as a clean-slate cutover during development: existing
Ed25519-derived envelopes and seeds are treated as disposable, so **no legacy
envelope migration is implemented or required** (the earlier `resealKeysForSelf`
migration helper and its UI actions were removed). A production rollout would
instead need a migration gate before deleting the seed, because the seed is the
only opener for a pre-ADR-0008 envelope.

## Context
The web client currently persists the device identity as an exportable Ed25519
seed (`private_key`, base64) in `localStorage`/IndexedDB, and derives the
device's X25519 encryption key from it on demand
(`ed25519PrivateToX25519`, ADR-0001). The open item asks to replace that with a
non-exportable WebCrypto Ed25519 key held as a handle in IndexedDB.

The blocker is the envelope design: opening a FEK envelope requires the X25519
private key, which is derived from the Ed25519 **seed**. A non-extractable
`CryptoKey` deliberately cannot yield that seed, so signing and envelope
decryption cannot share one non-extractable key. Doing the item as stated would
break file/folder decryption on the device that owns the key.

## Decision (proposed)
Give each device **two** keys with distinct jobs:

1. A non-extractable Ed25519 `CryptoKey` (opaque handle, stored in IndexedDB)
   used only for signing: relay signaling, device-auth challenges, recovery
   challenges, shard manifests.
2. A separate X25519 encryption keypair used only for FEK/folder-key envelopes.
   Its private half is stored as a CryptoKey (non-extractable where the platform
   supports X25519 ECDH, otherwise a keychain entry on native); its **public**
   half is published to the Relay and shown in the device/node catalogue.

Senders seal envelopes to the recipient's published X25519 public key directly
instead of deriving it from the Ed25519 key. `recipient_id` remains the device
id / node id; the catalogues gain an `encryption_public_key` field.

## Consequences
- **Positive:** signing keys can be non-extractable on web; envelope and signing
  keys have single, clearer purposes; future rotation can be per-purpose.
- **Negative / scope:** this is a protocol change touching the Relay schema and
  device registration, the Rust Storage Node's registration and snapshot, the
  key-envelope recipient decoding in `packages/sdk`, and both clients. It must
  ship with a migration for existing accounts (their devices have no X25519
  public key on file) and a fallback to the current Ed25519→X25519 derivation
  until every device has re-registered.
- **Security gain is real but bounded:** it removes the long-lived exportable
  signing seed from JS-readable storage; the X25519 envelope key remains
  sensitive (it can decrypt files), so it must stay in the keychain on native and
  a non-extractable key on web where possible.

## Alternatives considered
- **Keep the seed for X25519 only, add a non-extractable signing key.** Does not
  meet the item's goal (the seed remains exportable) and adds a second identity.
- **Wrap the seed with a non-extractable AES-GCM CryptoKey.** The wrapped seed
  is still recoverable by any script that can call the unwrap; only a
  non-extractable key that never leaves the crypto boundary helps.

## Recommendation
Accept only together with the catalogue/migration work; until then the open item
stays unchecked and should not be done as a drive-by change.
