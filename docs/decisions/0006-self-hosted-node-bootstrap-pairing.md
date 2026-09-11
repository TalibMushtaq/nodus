# ADR-0006: Self-Hosted Node Bootstrap Pairing

## Status
Accepted

## Context
Storage Nodes are separate machines (plan §11) that must be associated with an
account before they can sync. An earlier option was QR-based LAN node bootstrap
(plan §7b "Non-goals"), which requires the phone/device and the node to be
co-located and reachable on the same network. The server unit is self-hosted and
exposed at a single public origin (plan §3b), and nodes connect outbound over
WSS, so first-time association needs a credential that crosses the public
internet without a shared LAN — and that never becomes a long-lived secret.

## Decision
First-time node bootstrap uses a one-time **pairing code** (`NODUS-XXXX-XXXX`),
not a QR code:

- Minted by an authenticated account via `POST /pairing/codes`. Only the
  SHA-256 hash of the normalized code is stored; the plaintext is returned once
  and never logged. TTL: 15 minutes.
- Redeemed by the node through the open, IP rate-limited
  `POST /pairing/codes/redeem`, which **atomically** consumes the code and
  upserts the `storage_nodes` row bound to the issuing account in one
  transaction (reusing the first-node `is_primary` rule). A rejected
  registration (e.g. a node owned by another account) rolls the transaction
  back, so the code is not burned and ownership never moves accounts.
- The code is a **bootstrap credential only**. It attaches the node's
  persistent Ed25519 identity to an account and is never used again; permanent
  authentication remains the existing `/ws` challenge-response (§8). No new
  identity layer, token, or long-lived auth protocol is introduced.
- `nodus node pair` resolves the relay URL with the locked precedence (CLI
  `--relay` > `config.toml relay_url` > `NODUS_RELAY_URL` > none), redeems over
  HTTPS, and persists `relay_url` **only after** success. First-run resolution
  never defaults to localhost/127.0.0.1.

## Consequences
- **Positive:** works across the public internet with no co-located scanner;
  hashed storage + single-use + 15-minute TTL + IP rate limiting + HTTPS-only
  mitigate code theft and replay; node identity and the existing auth path are
  reused unchanged; deployment is self-hosted with no project-operated relay.
- **Negative:** a human transfers the code and URL to the node (a command
  rather than a scan); re-pairing and key rotation are v1 non-goals.
- **Deferred, not precluded:** QR pairing can later encode `{relay_url, code}`
  and reuse the exact same redemption mechanism, so this decision does not
  block the QR UX if it is revisited.
