# Bootstrap Pairing Security (Phase 7b)

## Scope

The Relay's **pairing-code** endpoints used to associate a first-time Storage
Node with an account (`nodus node pair`). This is distinct from the Phase 11
device↔node pairing tokens documented in
[`local-endpoints.md`](./local-endpoints.md): pairing codes bind a *node* to an
account over the public internet; pairing tokens bind a *device* to a node on
the LAN. Both are bootstrap credentials only.

The pairing code is **not** a long-lived credential. After setup, permanent
node trust is the node's persistent Ed25519 identity verified through the
existing `/ws` challenge-response (ADR-0006, plan §7b/§8).

## Endpoints

### `POST /pairing/codes` — mint (authenticated)

- Requires a valid account session (opaque `HttpOnly` cookie).
- Generates a code with a CSPRNG (`crypto/rand`): alphabet `A-Z` minus `I`/`O`
  plus `2-9` (32 symbols), format `NODUS-XXXX-XXXX` (8 symbols, ~2^40 space).
- Stores **only** `sha256(normalize(code))` (lowercase hex); `normalize` is
  upper-case + hyphen-stripped. Sets `expires_at = now + 15 minutes`, status
  `PENDING`.
- Returns `201 { code, expires_at }`. The plaintext code appears exactly once,
  in this response; it is never logged or retrievable again.

### `POST /pairing/codes/redeem` — redeem (open)

- The code **is** the credential; no session is required.
- Body: `{ code, node_id, public_key }` — `public_key` is the node's
  hex-encoded Ed25519 public key (32 bytes); `node_id` is non-empty, ≤128
  printable ASCII.
- Per-IP token-bucket rate limiting (burst 10, refill 2/s) → `429
  rate_limit_exceeded`. The client IP is the socket peer; `X-Forwarded-For` is
  trusted only when `TRUST_PROXY=true` (the Relay sits behind the operator's
  TLS reverse proxy) and only for a parseable first value.
- Atomically consumes the code and upserts the `storage_nodes` row bound to the
  issuing account **in one transaction**, reusing the first-node `is_primary`
  rule. A rejected registration rolls back, so the code is not burned and a
  node's ownership never moves accounts.
- Returns `200 { status: "ok", account_id, is_primary }`.

## Failure reasons

Machine-readable `{"error": "<reason>"}` bodies, with HTTP statuses matching the
Relay's conventions:

| Status | Reason | Meaning |
|---|---|---|
| 404 | `code_unknown` | No row for the normalized+hashed code |
| 410 | `code_expired` | Row is `PENDING` but past `expires_at` |
| 410 | `code_revoked` | Row status `REVOKED` (reserved; nothing revokes yet) |
| 409 | `code_consumed` | Code was already redeemed |
| 409 | `node_owned_elsewhere` | Node id is registered to a different account |
| 400 | `invalid node_id format` / `invalid public_key format` / body errors | Malformed request |
| 429 | `rate_limit_exceeded` | Per-IP limiter tripped |

Re-registering a node the account already owns is idempotent.

## Guarantees

- **Hash-only storage.** The `pairing_codes` table never contains the plaintext
  code; only its SHA-256 hash is persisted, and consumed rows are retained for
  audit.
- **Never logged.** The plaintext is not written to logs, the database, or any
  response after issuance.
- **Single-use and atomic.** Consumption is a conditional update inside the
  same transaction as registration; concurrent redeems cannot double-claim and a
  rejected registration cannot consume the code.
- **Short-lived.** 15-minute TTL plus rate limiting bound the exposure window.
- **Transport is HTTPS/WSS only** in production (plan §3b); the node dials the
  operator-configured `PUBLIC_RELAY_URL` and persists the relay URL only after a
  successful redeem.
- **No new identity layer.** The code only attaches the node's existing Ed25519
  key; account, device, node, and file-encryption identities stay separate
  (plan §8).

## Threat model

| Threat | Mitigation |
|---|---|
| Code theft from the DB | Hash-only storage; plaintext never persisted |
| Code interception in transit | HTTPS-only redemption; short TTL |
| Replay of a redeemed code | Atomic single-use consume; consumed rows kept |
| Brute force / spraying | 2^40 code space + per-IP rate limiting |
| Node takeover by a different account | Ownership-safe upsert → `node_owned_elsewhere`; accounts never move |
| Device impersonating a node after setup | Permanent trust is the node's Ed25519 key via WS challenge-response; the code is never reused |
| Operating a central relay to harvest codes | Self-hosted, operator-owned unit; no project-operated relay |

## V1 non-goals

QR pairing (deferred; may later encode `{relay_url, code}` and reuse the same
redemption), re-pairing/key rotation, central/shared Relay, automatic public-URL
discovery, requiring the code after setup, and any second long-term auth
protocol.
