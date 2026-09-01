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
