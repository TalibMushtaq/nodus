# Security

Threat models, trust boundaries, and the security posture of each endpoint
surface. Key hierarchy and encryption details live in the ADRs
(`docs/decisions/`) and `nodus_implementation_plan.md` §10.

| Document | Covers |
|---|---|
| [`local-endpoints.md`](./local-endpoints.md) | The Storage Node's LAN HTTP listener: discovery, device challenge-response, and Relay-issued device pairing tokens (Phase 11). |
| [`bootstrap-pairing.md`](./bootstrap-pairing.md) | The Relay's one-time pairing-code endpoints that associate a first-time Storage Node with an account (Phase 7b): hashed storage, atomic single-use redemption, rate limiting, and failure reasons. |
