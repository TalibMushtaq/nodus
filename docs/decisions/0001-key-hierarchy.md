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
