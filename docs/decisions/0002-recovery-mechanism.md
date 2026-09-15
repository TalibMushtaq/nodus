# ADR-0002: Account Recovery Mechanism

## Status
Accepted

## Context
Plan §9 and §24 require a way to recover account access when all trusted devices are lost, including the offline "lost phone → new phone via local Storage Node" path.

## Decision
v1 uses a **BIP39-style recovery phrase**, generated at account creation and shown once for the user to record themselves. The recovery phrase derives (or unlocks) the root key material needed to re-establish a trusted device.

## Consequences
- Positive: works fully offline (no dependency on a secondary device or third parties), simple mental model, well-understood pattern.
- Negative: recovery is entirely the user's responsibility — a lost phrase means permanent loss of access with no fallback. UI must make the one-time reveal and the stakes of losing it unmistakable.
- Implementation note: the recovery flow in plan §24 ("discover node locally → authenticate node → recover key material → register new device") must accept the recovery phrase as the credential that authenticates the recovery request, both online (via Relay) and offline (via a paired Storage Node on the same Wi-Fi/LAN).

## Implementation (2026-09-14)

- **Key derivation.** The 24-word phrase is converted to its BIP39 seed and then
  HKDF-SHA256 (info `nodus-recovery-identity-v1`) to a 32-byte Ed25519 seed, so
  the recovery identity reuses the same Ed25519→X25519 construction as devices
  and nodes (ADR-0001). `packages/core/src/recovery.ts` is the single source.
- **Account storage.** The account stores only the recovery **public** key
  (`accounts.recovery_public_key`); the phrase never leaves the client. A trusted
  device enrolls/rotates it via `PUT /account/recovery`.
- **Envelope recipient.** File and folder keys are also sealed to the recovery
  identity as `recipient_kind = "recovery"` (protocol 1.8). The `recipient_id` is
  the recovery public key itself, so a Storage Node holding the envelopes can
  verify a recovery signature without separate account metadata.
- **Online recovery.** `POST /auth/recovery/challenge` issues a single-use
  nonce; `POST /auth/recovery` verifies an Ed25519 signature over it, registers
  the new device, and mints a session — no password required. The client then
  opens its recovery envelopes and writes the keys to local stores
  (`materializeRecoveryKeys`), so downloads work immediately.
- **Phrase locality.** The phrase is kept in the same local IndexedDB as file
  encryption keys so the Security card can reveal/copy it; this matches the
  existing "trusted device" threat model. It is never sent to any server.
- **Not yet implemented.** Offline recovery through a Storage Node's local HTTP
  endpoints (§24) is deferred; recovery endpoints are not yet rate-limited.

## Offline recovery design requirements (deferred, 2026-09-15)

A survey of the Rust node for the §24 offline path found the following gaps
that must be resolved by a dedicated design before implementation:

- **The node does not persist an account identifier.** `storage-node`'s
  `devices` table has no `account_id` (only `pairing_sessions` carry one at
  redemption), so the node cannot tell a recovering client which account it is
  bound to, nor return an `account_id` the client needs to key its local stores.
  A `node_account`/settings row written during pairing is required.
- **The node's recovery public key is only implicit.** It can be learned from
  `key_envelopes` rows with `recipient_kind = 'recovery'` (the `recipient_id` is
  the recovery public key), but there is no explicit, queryable record and no
  guard for the "recovery not enrolled" case.
- **New local endpoints** are needed: a challenge that returns the recovery
  public key, a recovery POST that verifies an Ed25519 signature over the nonce
  and registers the new device, and a signed fetch of the recovery envelopes so
  the client can unlock keys with no Internet. Each needs its own nonce store
  and rate limit (the existing challenge budget must not be shared).
- **Trust boundary:** these endpoints grant key material to whoever holds the
  phrase, so they must be LAN-only, rate-limited, and never expose envelopes for
  a `recipient_kind` other than `recovery`.

Until that design is accepted, recovery requires Relay reachability; the mobile
client states this explicitly instead of showing a generic error.
