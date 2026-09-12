# ADR-0001: Key Agreement Mechanism and Device Revocation Flow

## Status
Accepted

## Context
The Account → Device → Storage Node key hierarchy and the File Encryption Key envelope format (plan §25) need a concrete key-agreement primitive and a defined revocation behavior before storage/sync code can be written against them.

## Decision
- Key agreement mechanism: **X25519** for all device/node key pairs.
- Device revocation: revoking a device **removes its key envelope only**. File encryption keys are **not rotated** on revocation.

## Consequences
- Positive: revocation is O(1) — delete one envelope record, no re-encryption or re-distribution of file keys to remaining devices.
- Negative (accepted tradeoff): a device that was compromised before revocation retains the ability to decrypt any ciphertext it already downloaded. This is an explicitly accepted risk for v1, not an oversight.
- Implementation note: envelope format must be designed so a revoked device's entry can be deleted independently, without touching other devices' envelopes for the same file (plan §4.3 / §25).

## Decision (2026-09-12, Phase 14 F2): encryption key derived from the identity key

Device and node **identity** is Ed25519 in the implementation (signing,
challenge-response, pairing), while the FEK envelope primitive is X25519. The
encryption key is **derived from the Ed25519 identity** via the standard
Edwards→Montgomery conversion (`@noble/curves` `edwardsToMontgomeryPub` /
`edwardsToMontgomeryPriv`, wrapped as `deriveEncryptionKeypair` in
`packages/core`). A sender who only knows the Ed25519 public key computes the
matching X25519 key and seals the FEK; the recipient derives the X25519 private
key from its own seed and opens it.

- **Rationale.** One identity per device/node, no second keypair, no new
  pairing/registration field, and no migration for already-paired identities.
  This is a well-established technique — `age`'s `ssh-ed25519` recipients and
  libsodium's `crypto_sign_ed25519_sk_to_curve25519` use the same construction.
- **Accepted tradeoff.** Key reuse is a hygiene preference, not a demonstrated
  exploit path: a party that obtains the X25519 encryption private key also
  obtains the Ed25519 signing key (and vice versa). This is accepted for v1;
  because files are encrypted under envelopes sealed to the derived key,
  switching to independent keypairs later requires re-keying every existing
  envelope, so this decision is treated as durable.
- **Transport.** Envelopes are event-sourced (`KEY_ENVELOPE_ADDED`) so they flow
  through the same device sync path as file/folder metadata, and are carried in
  snapshots so a full Relay rebuild preserves them (Phase 14 F2c).
