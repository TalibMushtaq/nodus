# Local Discovery & Node Authentication (Phase 11)

## Status

Accepted — locked design for v1. Do not revisit the decisions below
mid-implementation.

## Goal

Let web + mobile clients discover the Rust Storage Node on the local
network, pair with it for the first time, and authenticate to it offline on
every subsequent connection — without the Relay being involved in the data
transfer (the foundation for Path A/B).

## mDNS service format

- Service type: `_nodus._tcp.local`
- Port: configurable, default `9378`
- TXT records:

| Key | Value | Purpose |
|---|---|---|
| `node_id` | hex-encoded Node ID (Ed25519 pubkey) | primary identifier |
| `v` | `1` | service/protocol version |
| `pk_fp` | first 8 bytes of pubkey hash, hex | cheap pre-check before opening a connection; avoids wasted challenge round-trips when multiple nodes are on one LAN |

`pk_fp` is computed by BLAKE3-hashing the node public key and taking the
first 8 bytes, hex-encoded. It is **not** a trust anchor — it only lets a
browser/phone skip opening a TCP connection to a node it can already rule out.

## Local endpoint security

Plain HTTP + Ed25519 challenge-response. No TLS/mTLS/Noise for v1.

Rationale:

- Bulk file data moves over WebRTC (DTLS-encrypted), so confidentiality of
  data does not depend on this listener.
- Challenge-response proves node identity cryptographically, so a rogue LAN
  device cannot impersonate a real node.
- The only real exposure is the pairing token / handshake bytes in transit.
  This is mitigated structurally rather than with transport encryption:
  - Pairing tokens are **single-use** and **short-lived** (15 min TTL).
  - Tokens are **bound to the requesting device's pubkey at issuance** — a
    sniffed-but-unredeemed token cannot be replayed by a different device.
  - Challenge nonces are **single-use**, tracked server-side, in addition to
    their 30s TTL.

Revisit TLS in a later phase if untrusted-LAN scenarios (public Wi-Fi) become
in-scope.

## Local HTTP API (device ↔ node)

| Endpoint | Method | Auth | Behavior |
|---|---|---|---|
| `/nodus/discovery` | GET | none | Returns `{ node_id, public_key, schema_version }` — read-only identity advertisement |
| `/nodus/challenge` | POST | none | Returns `{ nonce }`, 32 random bytes, 30s TTL, single-use |
| `/nodus/auth` | POST | — | Accepts `{ device_id, nonce, signature }`; verifies the signature over the issued nonce against the known device pubkey |
| `/nodus/pair` | POST | pairing token | Accepts Relay-issued token + device pubkey; validates single-use server-side; on success inserts into `devices` |

CORS on the node listener is permissive so the browser web client can probe
`/nodus/discovery` from any origin (home-LAN trust model).

## First-time pairing

```text
Client                                Relay                             Node
  |                                     |                                |
  | account auth (JWT)                  |                                |
  |------------------------------------>|                                |
  | POST /pairing/sessions              |                                |
  |   { node_id, device_pubkey }        |                                |
  |------------------------------------>|                                |
  |                                     | push pairing_token_push (WS)  |
  |                                     |-------------------------------|-> store token
  | <-- { token }                      |                                |
  |                                     |                                |
  | POST /nodus/pair                   |                                |
  |   { token, device_pubkey }         |                                |
  |----------------------------------->|                                |
  |  local pairing_sessions lookup      |                                |
  |  (miss → POST /pairing/sessions/verify, notify Relay of redemption) |
  | <-- PairingConfirm                 |                                |
  |                                     |                                |
```

Pairing URL format (QR payload):

```text
nodus://pair?node_id=<hex>&pubkey=<base64>&token=<relay-issued-token>
```

- `node_id` and `pubkey` identify the target node (node_id is derived from
  the pubkey; both are present so a scanner can show an identifier even
  before opening a connection).
- `token` is the Relay-issued, device-bound, single-use token.

## Subsequent offline auth

```text
mDNS discovery / manual IP
      |
      v
Known Node ID?
      |
      +-- No --> Pairing required
      |
      +-- Yes
            |
            v
   POST /nodus/challenge  ->  nonce
            |
            v
   POST /nodus/auth  (device_id + Ed25519 signature over nonce)
            |
            v
        Authenticated
            |
            v
          WebRTC (next phase)
```

The IP address is only a network location, never the trust anchor.

## Pairing token verification — hybrid push + pull

Relay **pushes** the token to the node over the existing WS connection on
issuance (fast path). The node stores it in `pairing_sessions`.

The node's `/nodus/pair` handler checks its local `pairing_sessions` first
(fast, offline-capable for the common case). If the token isn't found locally
(the push hasn't landed yet, or the node reconnected mid-window), the node
makes a synchronous call to `POST /pairing/sessions/verify` on the Relay,
which atomically redeems the token (marks `consumed_at`).

If the node is fully offline and has no local record of the token, pairing
fails with a clear "node unreachable" error. First-time pairing while the
node is fully offline is explicitly not a v1 target.

## Message type transport split

| Message types | Transport | In `envelope.ts` WS registry? |
|---|---|---|
| `local-discovery.ts`, `local-auth.ts` | HTTP only | No |
| `pairing.ts` HTTP payloads | HTTP only | No |
| `pairing_token_push` (Relay → Node, in `pairing.ts`) | WS only | **Yes** |

Only `pairing_token_push` is registered in `MessageTypes` /
`MessagePayloadSchemas`, because only it travels over the Relay↔Node
WebSocket.