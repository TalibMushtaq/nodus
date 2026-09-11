# Nodus — Hybrid Offline-First P2P Storage System — Implementation Plan

## 0. Foundational Design Decisions (Resolve Before Step 1)

Five decisions currently listed as "remaining design decisions" in §29 are load-bearing —
storage schema, sync protocol, and client behavior all assume answers to these exist.
Resolve them first, on paper, before writing the Rust SQLite schema or the protocol
package. Revisiting them mid-build is far more expensive than revisiting them now.

1. **Key hierarchy and recovery-key mechanism** (detailed in §9, §25, §29). Device
   revocation, node trust, snapshot signing, and key envelopes all depend on this.
   > Resolved — see docs/decisions/0001-key-hierarchy.md and docs/decisions/0002-recovery-mechanism.md
2. **Conflict-resolution UX** (expanded in §17a below). "Let the user resolve it" needs
   a concrete mechanism before the file state machine (§23) can be finalized.
   > Resolved — see docs/decisions/0003-conflict-resolution-ux.md
3. **Mobile local-discovery approach** (expanded in §7a below). Whether Path A (Direct
   Local P2P) is reliable on mobile at all depends on this.
   > Resolved — see docs/decisions/0004-mobile-local-discovery.md
4. **Reconciliation repair action** (expanded in §21a below). Detecting divergence is
   only half the job.
   > Resolved — see docs/decisions/
5. **Garbage-collection policy** (expanded in §29a below). Immutable versions +
   tombstones + content-addressed objects accumulate storage indefinitely without one.
   > Resolved — see docs/decisions/0005-garbage-collection-policy.md

---

## 1. Project Goal

Build **Nodus**, a hybrid, offline-first P2P storage system where:

- A Next.js web app and React Native/Expo mobile app act as clients.
- A Rust Storage Node provides durable local storage.
- A Go Relay provides Internet-facing signaling, synchronization, authentication/control-plane services, and temporary encrypted buffering.
- Clients can continue operating with the Rust Storage Node over the local network (Wi-Fi or wired LAN) when the Internet is unavailable.
- Relay metadata can be rebuilt from Storage Nodes if the Relay database is corrupted or lost.

The original system design defines four deployable components: web client, mobile client, Go Relay Server, and Rust Storage Node.

---

## 2. Repository Architecture

The system will use **a single Git monorepo** named `nodus`, rather than splitting components across separate repositories.

This is preferred for a project at this stage because it keeps protocol changes, client changes, and server changes atomic in one commit/PR, avoids cross-repo version-pinning overhead, and gives one place to run CI, track issues, and onboard contributors. Independently deployable does not require independently repo'd — the components below still deploy separately; they just live in one tree.

### Single Repository: `nodus`

```text
nodus/
    protocol/     Canonical protocol specification, message schemas,
                   shard format, sync protocol, versioning
    sdk/           Shared TypeScript client/core libraries, used by Web and Mobile
    web/           Next.js — Web UI, browser-specific implementations
    mobile/        React Native / Expo — Mobile UI, native/mobile-specific implementations
    node/          Rust — Storage daemon, SQLite, object store, local P2P, sync
    relay/         Go — Relay, PostgreSQL, Redis, temporary buffer, sync service
```

(See §3a for the full directory layout, including where each of these lands
under `apps/`, `packages/`, and `services/`.)

### Internal boundaries

Even inside one repository, components should communicate through **explicit protocol contracts**, not by reaching into each other's internals. Language boundaries (TypeScript ↔ Rust ↔ Go) enforce this naturally; the `protocol` package is the shared contract all of them build against.

```text
                        protocol
                           |
          +----------------+----------------+
          |                |                |
          v                v                v
        Web             Mobile             Rust
          |                |                |
          +----------------+----------------+
                           |
                           v
                         Relay
```

The Web and Mobile applications share TypeScript through the `sdk` package. Rust and Go remain independent implementations of the same protocol contract — they just live in the same repo rather than their own.

### Why one repo instead of six?

- one place to open a PR that touches protocol + client + server together
- one CI entry point, with per-component jobs/paths as needed
- one issue tracker, one set of docs, one version history
- easier for a small team (or solo build) to keep everything in sync
- protocol versioning is still enforced explicitly (§4), not implicitly by repo boundaries

Trade-offs worth knowing going in: Rust and Go tooling won't get their own repo-level release cadence or access controls, and the repo will mix languages/build systems in one tree. CI should still scope jobs by changed path (e.g. only run Rust tests when `node/` changes) so this doesn't become a bottleneck.

The shared `sdk` package should contain only genuinely portable logic such as domain types, sharding, protocol serialization, and crypto abstractions. Platform implementations remain separate.

---

## 3. High-Level Architecture

```text
                         INTERNET
                            |
                            v
                 +----------------------+
                 |    Go Relay / API    |
                 |                      |
                 | PostgreSQL           |
                 | Redis                |
                 | Temporary Buffer     |
                 +----------+-----------+
                            |
                       Sync Protocol
                            |
                    --------+--------
                            |
                        Wi-Fi / LAN
                            |
                 +----------v-----------+
                 |    Rust Storage      |
                 |        Node          |
                 |                      |
                 | SQLite               |
                 | Object Store         |
                 | Node Identity        |
                 | Sync Log             |
                 +----------+-----------+
                            |
                     Local WebRTC
                            |
                 +----------v-----------+
                 |     Web / Mobile     |
                 |       Client         |
                 +----------------------+
```

### Core principle

> The Rust Storage Node is authoritative for the data physically stored on that node. The Relay is an Internet-accessible synchronization/control plane and temporary transport buffer.

The Relay must not be a mandatory dependency for local operation.

---

## 3a. Repository Structure (TypeScript Workspace)

> Note: this section was originally numbered "3", duplicating the High-Level Architecture
> section above. Renumbered to 3a to avoid ambiguity; all later section numbers are
> unchanged from the original document.

Use **Turborepo + pnpm** for the TypeScript side.

```text
nodus/
|
+-- apps/
|   +-- web/                    # Next.js
|   +-- mobile/                 # React Native / Expo
|
+-- packages/
|   +-- core/                   # Domain logic, sharding, crypto abstractions
|   +-- protocol/               # Canonical protocol schemas/types
|   +-- relay-client/           # WebSocket client
|   +-- webrtc-transport/       # WebRTC abstraction
|   +-- config/                 # Shared TypeScript tooling
|
+-- services/
|   +-- api/                    # Control-plane API
|   +-- relay/                  # Go Relay
|   +-- storage-node/            # Rust Storage Node
|
+-- infra/
|   +-- docker/
|   +-- compose/
|   +-- scripts/
|
+-- docs/
|   +-- architecture/
|   +-- protocol/
|   +-- security/
|   +-- decisions/
|
+-- tests/
|   +-- integration/
|   +-- e2e/
|
+-- pnpm-workspace.yaml
+-- turbo.json
+-- package.json
```

### Turborepo boundary

Turborepo manages:

```text
apps/web
apps/mobile
packages/*
```

Go and Rust remain in the same Git repository but are not forced into the pnpm workspace.

---

## 3b. Self-Hosted Deployment

Every Nodus server is **self-hosted**. There is no central/shared public Relay
operated by the project. Each operator deploys and owns the whole server unit:

```text
Next.js web app + Go Relay/API + PostgreSQL + Redis
        exposed through a single public origin behind reverse proxy/TLS

https://nodus.example.com
    https://nodus.example.com/*       -> Next.js
    https://nodus.example.com/api/*   -> Go Relay/API
    wss://nodus.example.com/ws        -> Go Relay WebSocket
```

The Next.js app and the Go Relay ship together in **one deployable server
unit** (Next.js API routes proxy HTTP to the Relay per §3a/`apps/web/lib/relay.ts`;
`/ws` remains the Relay WebSocket gateway). Docker-internal hostnames are used
**only inside the deployment**.

Rust Storage Nodes run on separate machines and MUST connect only through the
externally reachable public origin — never localhost/127.0.0.1, Docker service
names, or container addresses.

The public URL is operator-configured **explicitly**:

```text
PUBLIC_RELAY_URL=https://nodus.example.com
```

It is **never inferred** from Host headers, Docker names, or internal addresses.
The web UI reads `PUBLIC_RELAY_URL` to display the exact URL a user types into a
`nodus node pair` prompt (see §7b/§7c). WS-Server/origin and CORS settings come
from `AllowedOrigins` (see `services/relay/internal/config/config.go`).

---

## 4. Shared TypeScript Packages

### `packages/core`

Pure domain logic:

- File and shard types
- 8 MB shard splitting
- Shard reconstruction
- AES-256-GCM interfaces
- Key derivation interfaces
- BLAKE3-related logic
- Transfer state machine
- Retry/backoff logic

`core` should not depend on React, Next.js, Expo, browser APIs, or React Native.

### `packages/protocol`

Canonical network protocol definitions.

Initial message types:

```text
register
heartbeat
webrtc_offer
webrtc_answer
webrtc_ice_candidate
shard_upload
shard_ack
pending_notify
shard_fetch
shard_delete
sync_hello
sync_status
event_batch
snapshot_begin
snapshot_chunk
snapshot_end
reconcile
```

Use runtime validation in addition to TypeScript types.

### `packages/relay-client`

Responsible for:

- WebSocket connection
- Reconnection
- Heartbeats
- Message routing
- Relay presence
- Sending/receiving protocol messages

### `packages/webrtc-transport`

Responsible only for:

- Peer connection
- SDP offer/answer
- ICE candidates
- DataChannel
- Data streaming

The Transfer Manager decides whether WebRTC or relay buffering is used.

---

## 5. Transfer Paths

### Path A — Direct Local P2P

```text
Client
  |
  | Local signaling
  v
Rust Storage Node
  |
  | WebRTC DataChannel
  v
Encrypted shards
```

The Relay is not required.

Local signaling requires both devices to be on the same local network —
same Wi-Fi network or wired LAN, sharing a subnet. This is the common case
(home Wi-Fi, office Wi-Fi) and the primary target for Path A; see §7 for the
full network-scope clarification.

### Path B — Relay-Mediated Signaling + Direct WebRTC

```text
Client
  |
  | WebSocket signaling
  v
Relay
  |
  | SDP / ICE
  v
Rust Storage Node
  |
  | WebRTC DataChannel
  v
Encrypted shards
```

The Relay carries signaling but not file data.

### Path C — Buffer-and-Relay

```text
Client
  |
  | encrypted shard
  v
Relay temporary buffer
  |
  | asynchronous delivery
  v
Rust Storage Node
```

Used when direct P2P is unavailable or the Storage Node is offline.

### Path D — Local Queue

If both the Storage Node and Relay are unavailable:

```text
Client
  |
  v
Local persistent queue
  |
  v
Retry later
```

---

## 6. Transfer Manager

The Transfer Manager is the central state machine.

Priority:

```text
Local signaling
      |
      v
Direct WebRTC
      |
      | failure
      v
Relay signaling
      |
      v
Direct WebRTC
      |
      | failure
      v
Buffer-and-Relay
      |
      | Relay unavailable
      v
Local persistent queue
```

Use bounded timeouts and exponential backoff.

The initial WebRTC negotiation timeout is approximately 4 seconds, subject to early benchmarking.

Benchmark this against real Wi-Fi/NAT conditions (not just localhost/LAN-in-a-lab)
before locking it in — a timeout that's too aggressive will thrash through the
fallback chain (Local → Relay signaling → Buffer → Queue) unnecessarily on flaky
but usable networks, adding latency and Relay load that direct P2P was meant to avoid.

---

## 7. Local P2P Discovery and Authentication

### Network scope clarification

Every use of "LAN" in this document means: **both devices connected to the same
network — Wi-Fi or wired Ethernet — such that they share a subnet and can reach
each other directly**, typically because they're joined to the same router/access
point (a home Wi-Fi network, an office Wi-Fi network, or a wired LAN).

**Wi-Fi is the primary target scenario**, not an edge case — most phones,
laptops, and Storage Nodes in practice will be connected over Wi-Fi rather
than wired Ethernet. "LAN" is used throughout this document as shorthand for
"same local network," and should not be read as implying wired-only. mDNS
discovery and local WebRTC signaling both work over Wi-Fi or wired Ethernet
without any changes, as long as the two devices share a subnet.

Explicitly **out of scope for v1** unless called out separately later: Wi-Fi
Direct / device-to-device Wi-Fi with no shared access point, and a phone's mobile
hotspot acting as the only link (no router in the middle). Those scenarios change
how discovery has to work (there's no common AP to broadcast mDNS through) and
would need their own design pass if you want them later.

### Discovery is not authentication

mDNS answers:

> Which Storage Nodes are available on this LAN?

It does not establish trust.

### Storage Node identity

Each Rust node generates a persistent asymmetric keypair:

```text
Node
 |
 +-- Private key  (never leaves node)
 |
 +-- Public key
 |
 +-- Node ID
```

The Node ID is derived from the public identity.

### First-time pairing

Initial setup may require Internet:

```text
Install client
    |
    v
Create/login to account
    |
    v
Relay authentication
    |
    v
Pair Rust Storage Node
    |
    v
Establish cryptographic identities
```

Two distinct pairing flows exist and **must not be conflated**:

1. **Account → new Storage Node bootstrap (§7b, canonical).** A node that has
   never been associated with an account is bound to it using a short-lived,
   single-use **pairing code** (e.g. `NODUS-7K4P-92XM`) issued by the account's
   own self-hosted Relay. Requires Internet/Relay reachability; this is the
   flow implemented by `nodus node pair` and described in §7c.
2. **Device ↔ node local trust (Phase 11).** A client device already tied to the
   account becomes locally trusted by a node via relay-issued pairing tokens
   (`/nodus/pair`). This is a separate flow with its own endpoints and is not
   used to bootstrap a never-registered node.

QR-based pairing is **not a v1 path** for node bootstrap. If added later it must
**encode `{relay_url, code}` and reuse the exact same redemption mechanism** —
never introduce a second pairing protocol (see §7b and §29).

The client stores the trusted Storage Node public key locally.

### Subsequent offline authentication

```text
mDNS discovery
      |
      v
Known Node ID?
      |
      +-- No --> Reject / pairing required
      |
      +-- Yes
            |
            v
       Challenge-response
            |
            v
       Verify signature
            |
            v
        Authenticated
            |
            v
          WebRTC
```

The IP address is only a network location, not the trust anchor.

---

## 7a. Mobile-Specific Local Discovery Risks

The plan currently treats mDNS discovery and local WebRTC signaling as uniform across
web and mobile. In practice the platforms diverge enough that Path A (Direct Local P2P)
cannot be assumed to work the same way on all clients:

```text
iOS
 |
 +-- Background mDNS/Bonjour browsing requires NSBonjourServices /
 |   NSLocalNetworkUsageDescription entitlements
 +-- No reliable background discovery once the app is suspended
 +-- Local network permission prompt is user-facing and can be denied

Android
 |
 +-- NSD (Network Service Discovery) works foreground; background
 |   requires a foreground service or WorkManager-driven retry
 +-- Behavior varies by OEM power-management policy

Browser (Web client)
 |
 +-- mDNS-based ICE candidates are supported inconsistently across
 |   browsers; local-network access prompts are still evolving
```

Decide explicitly, before building the Transfer Manager:

- Whether mobile clients attempt Path A at all when backgrounded, or fall back
  directly to Path B/C while backgrounded and only attempt Path A in the foreground.
- Whether Expo's managed workflow is sufficient, or whether a native module /
  bare workflow is required for reliable local discovery (this is the same
  question already flagged in §29 under "Mobile").
- What the client shows the user when local-network permission is denied, since
  that silently forces every transfer onto Path B/C.

---

## 7b. First-Time Node Pairing via Relay (Pairing Code)

### Model

The pairing code is **only a bootstrap credential**. Permanent trust remains the
node's persistent Ed25519 identity; after pairing, authentication is the existing
WebSocket challenge-response (§8). The code is **never** a long-lived credential
and never replaces node challenge-response.

```text
Pairing code
    |
    v  (one-time authorization to associate node with account)
account_id <-> node_id <-> Ed25519 public key
    |
    v  (permanent mechanism)
node <-> Relay WebSocket + Ed25519 challenge-response
```

Identity separation is preserved (§8): account identity, device identity, node
identity, and file-encryption identity remain distinct. The pairing code
introduces **no new identity layer**.

### Properties (locked)

- Format: `NODUS-XXXX-XXXX` (e.g. `NODUS-7K4P-92XM`); unambiguous alphabet
  (A-Z minus I and O, plus 2-9) so no code can be misread or mistyped.
- CSPRNG generated; **~15-minute lifetime**; **single-use**.
- **Atomically consumed** on successful redemption — concurrent redemption cannot
  double-claim a code. Consumption and `storage_nodes` registration share one
  transaction, so a rejected registration never burns the code.
- Stored in PostgreSQL **only as the SHA-256 hash** of the normalized code;
  plaintext is never stored or logged. Consumed rows are retained for auditability
  (do not delete).
- Redemption over **HTTPS only**; the redeem endpoint is **IP rate-limited**.

### API

```text
POST /pairing/codes              (authenticated — requires account session)
    -> { code: "NODUS-7K4P-92XM", expires_at }

POST /pairing/codes/redeem       (open — the code IS the credential)
    { code, node_id, public_key }
    -> { status: "ok", account_id }
```

Machine-readable failures: `code_unknown` (404) | `code_expired` (410) |
`code_revoked` (410) | `code_consumed` (409) | `node_owned_elsewhere` (409),
with HTTP statuses consistent with existing relay conventions (400/404/409/410;
the endpoint also returns 429 while IP rate-limited).

Redemption steps (Relay): normalize + hash the code → look up the pending record
→ validate not expired and not consumed → validate the node identity/public key
format → **atomically consume and upsert** the `storage_nodes` row bound to the
account in one transaction, **reusing the existing first-node/`is_primary` rule**
(see `services/relay/internal/handler/node.go`) → return success. A node already
registered to another account is rejected and must never move accounts; the
rejection rolls back the transaction so the code is **not** burned. Re-registering
a node the account already owns is idempotent.

### Database (Relay PostgreSQL)

New table in the next migration (009, after 008). Kept separate from `sessions`
and `pairing_sessions`:

```text
pairing_codes (
    code_hash   TEXT PRIMARY KEY,   -- sha256(normalized code)
    account_id  TEXT NOT NULL REFERENCES accounts,
    status      TEXT DEFAULT 'PENDING',   -- PENDING | CONSUMED | REVOKED
    node_id     TEXT REFERENCES storage_nodes,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);
CREATE INDEX idx_pairing_codes_account ON pairing_codes(account_id);
```

### Rust Storage Node

- Reuse the persistent Ed25519 identity (§11). **Never generate a new identity
  per pairing attempt.**
- See §7c for the full CLI UX.
- Steps: resolve relay URL → prompt for URL/code if absent → load the persistent
  identity → redeem over HTTPS → on success **persist `relay_url`** → report
  `node_id` + account_id → proceed to the normal connection flow.
- `account_id` is informational on the node; the Relay remains authoritative for
  account ownership.

### Reconnect after pairing

No second long-term auth protocol. The node connects to `/ws`, the Relay issues
`node_auth_challenge`, the node signs with Ed25519, the Relay verifies against
`storage_nodes`. The pairing code is **never required again** after setup.

### Unpaired-node UX

Extend `NodeAuthResultPayload` with an optional machine-readable reason
(e.g. `"node_not_found"`) when the node is unknown/inactive, so the node can
report "Storage Node is not paired. Run: `nodus node pair`" instead of a bare
"storage node not found or inactive" retry loop. Retry behavior for
already-paired nodes is unchanged.

### Security model

- **Code theft:** short TTL + single-use + hashed storage + no logging +
  HTTPS-only + rate limiting.
- **Replay:** atomic consumption (single conditional UPDATE where
  `consumed_at IS NULL`).
- **Node impersonation:** permanent trust is bound to the node's Ed25519 private
  key; the code only attaches whatever key the redeemer presents.
- **MITM:** production pairing requires HTTPS; the node WebSocket uses WSS.
- **Revocation:** existing node revocation invalidates future node auth; complex
  key rotation/re-pairing is a **v1 non-goal**.

### V1 non-goals

QR pairing (deferred — may later encode `{relay_url, code}` using the **same**
redemption), complex re-pairing, automatic key rotation, central shared Relay,
automatic public-URL discovery, requiring the code after setup, Docker-internal
URLs exposed to nodes, and any second long-term auth protocol.

### Tests

Covered in §28 stage 7b and `Todo.md` Phase 7b: Go (generation/alphabet/hash/
expiry/single-use/concurrent/expired/consumed/owned-elsewhere/`is_primary`/rate
limit), Rust (URL precedence, config persistence, pairing success/failure,
identity persistence, interactive + non-interactive CLI), Next (creation,
URL+code render, expiry, polling, failure states), E2E (register → node appears
→ paired → sync session authenticates).

---

## 7c. Node CLI: `nodus node pair`

UX for first-time node bootstrap (implemented in `services/storage-node`):

```text
nodus node pair                                   interactive default
nodus node pair --relay https://... --code NODUS-7K4P-92XM    scripted
nodus node start                                  normal boot after pairing
```

- `nodus node pair` with no flags prompts (via `dialoguer`) for the relay URL
  (defaulting to the configured/public URL if present) and then the code.
- URL precedence: **CLI `--relay` > `config.toml` `relay_url` > `NODUS_RELAY_URL`
  > no default** — a first-run pairing never silently targets localhost.
- On success the node persists `relay_url` into `~/.nodus/config.toml`, reports
  `node_id` + account_id, and proceeds to the normal /ws challenge-response flow.
- On failure it prints the machine-readable reason (`code_expired`, etc.) plus
  the "not paired — Run `nodus node pair`" guidance.
- The existing root flags (`--data-dir`, `--force-adopt`) still boot the daemon;
  the `node` subgroup is added on top, not a breaking CLI migration.

---

## 8. Account, Device, and Node Identity

Keep these identities separate:

```text
Account
 |
 +-- Device A
 +-- Device B
 +-- Storage Node
```

Each has its own cryptographic identity.

This allows individual device revocation:

```text
Phone A  -> REVOKED
Phone B  -> ACTIVE
Laptop   -> ACTIVE
Node     -> ACTIVE
```

without destroying the account.

### Identity layers (account vs device vs node vs file)

The four identity concerns are distinct and never substitute for one another:

| Layer | Mechanism | Verifier |
|---|---|---|
| Account authentication | **opaque, randomly generated server-side session ID** (only a SHA-256 hash is stored in PostgreSQL) | Relay session lookup |
| Device identity | device asymmetric key (public key registered to the account) | signature / key-envelope binding |
| Storage Node identity | node asymmetric key (Ed25519) | challenge-response + signature |
| File encryption | per-file encryption keys wrapped in key envelopes | cryptographic; Relay never sees plaintext |

Account authentication is **not** a JWT, access token, or refresh token — it is a server-side opaque session. Device and Node identity are already asymmetric-key based and are unchanged; only account authentication moves off JWT. See §13 (sessions table) and the auth-migration checklist in `Todo.md`.

The pairing code in §7b is a **bootstrap credential only** — it binds a new
Storage Node to an account and introduces **no** new identity layer. It never
substitutes for the node's Ed25519 identity, a device identity, or a session.

---

## 9. App Password and Recovery

The app password should not itself be the network identity.

Use:

```text
App Password
      |
      v
Password KDF
      |
      v
Encryption key
      |
      v
Encrypted device credentials
```

The device private key remains the cryptographic identity.

On login, the verifying credential is the **account password** (stored only as an Argon2id hash, never as a plaintext/network credential). A successful password check mints a new **opaque server-side session** bound to a registered device (see §8 identity layers and §13). The app password itself is never transmitted as a bearer credential and never maps to a JWT or refresh token.

A separate recovery credential should be provided for the case where the user loses their only trusted device.

---

## 10. Encryption and Sharding

File processing:

```text
File
 |
 +-- Generate random File Encryption Key
 |
 +-- Split into 8 MB shards
 |
 +-- Encrypt each shard with AES-256-GCM
 |
 +-- Unique nonce per shard
 |
 +-- BLAKE3 integrity metadata
 |
 v
Encrypted shards
```

The Relay only sees ciphertext.

The existing design uses:

- 8 MB shards
- AES-256-GCM
- unique nonce per shard
- BLAKE3 integrity hashes

---

## 11. Storage Node Layout

The node uses a split directory model: fixed OS-standard config for identity
and a tiny bootstrap config file, and a user-chosen location for the database
and object store (see §11a for the first-run setup flow that decides
`data_dir`).

```text
~/.nodus/                         (OS config dir — fixed)
|
+-- identity/
|   +-- node_private_key
|   +-- node_id
|
+-- config.toml                   (data_dir; relay_url added on pairing — §7b)

<data_dir>/                       (user-chosen, e.g. ~/NodusBackup)
|
+-- nodus.db
|
+-- objects/
|   +-- ab/
|   +-- cd/
|   +-- ...
|
+-- temp/
+-- logs/
```

### SQLite

Use SQLite for the Rust node because it is:

- embedded
- local
- transactional
- suitable for a single-node daemon
- usable without Internet or a database server

The SQLite database (`nodus.db`) lives inside `<data_dir>` rather than the
fixed config directory. Colocating it with the object store under a single
root simplifies a future migration flow (e.g. relocating the entire dataset
to an external drive) — see the v1 scope boundary in §11a.

### Object Store

Actual encrypted objects should be content-addressed rather than stored using the original filename.

The logical file metadata maps:

```text
filename
   |
   v
file_id
   |
   v
file version
   |
   v
BLAKE3 / object references
```

---

## 11a. Storage Node First-Run Setup

On first run the node must determine `<data_dir>`. The flow is:

1. **First-run detection** — if `~/.nodus/config.toml` exists, read `data_dir`
   from it and boot normally. This guarantees unattended daemon restarts never
   block on a prompt.
2. **Unattended install** — before falling back to an interactive prompt,
   check:
   - `--data-dir <path>` CLI flag
   - `NODUS_DATA_DIR` environment variable

   If either is present, validate the path, create it if necessary, write
   `config.toml`, and skip the prompt.
3. **Interactive prompt** — if no config exists and no unattended source is
   provided, prompt the user via `dialoguer` with a default suggestion (e.g.
   `~/NodusBackup`). Validate that the path is writable; offer to create the
   directory if missing.
4. **Warnings**:
   - *Non-blocking*: if the chosen path appears to be inside a cloud-sync
     folder (Dropbox, OneDrive, Google Drive, iCloud Drive) or is the root of
     a removable/network mount, warn the user and continue on confirmation.
   - *Blocking*: if the directory already contains `nodus.db` or `objects/`
     from a prior install, require explicit confirmation before adopting it.
     Do not silently overwrite or adopt existing data.
5. **Write `config.toml`** — once a path is accepted, persist `data_dir` to
   `~/.nodus/config.toml`.
6. **Pairing (first time only, separate from setup)** — run `nodus node pair`
   (§7b/§7c). `relay_url` is written to `config.toml` **only on successful
   pairing**; `nodus node start` afterwards resolves it via
   CLI `--relay` > `config.toml` `relay_url` > `NODUS_RELAY_URL` > **no
   default**. Remove the current first-run localhost default.

### v1 scope boundary

Changing `data_dir` after initial setup is **explicitly out of scope for v1**.
A future migration would need to move `nodus.db`, the object store, and update
all on-disk path references atomically — this requires a proper
migrate-and-verify flow, not a config file edit.

---

## 12. Rust SQLite Metadata

Suggested tables:

```text
files
file_versions
shards
storage_objects

devices
trusted_nodes

sync_events
sync_outbox
sync_cursors

tombstones
```

The Rust database is authoritative for the current state of that particular Storage Node.

---

## 13. Relay Databases

### PostgreSQL

Use PostgreSQL for durable control-plane metadata:

```text
accounts
devices
storage_nodes
pairing_codes             <- account->node bootstrap pairing (§7b); code stored hashed, single-use

sessions                  <- replaces refresh_tokens; opaque server-side sessions

files
file_versions
file_locations

key_envelopes

sync_events
sync_cursors

tombstones
```

### Sessions (account authentication)

Account authentication uses **server-side opaque sessions** — no JWTs, no access tokens, no refresh tokens. The `refresh_tokens` table is **dropped outright** (pre-production; no migration window, no dual auth model). It is replaced by a `sessions` table:

| Column | Notes |
|---|---|
| `session_id` | PK — ID of the session (opaque token value stored server-side) |
| `session_hash` | `UNIQUE` — SHA-256 of the raw session token; **only the hash is stored**, never the raw token (see below) |
| `account_id` | FK → `accounts` |
| `device_id` | FK → `devices` (**required** — every session is bound to a registered device) |
| `created_at` | set on issue |
| `expires_at` | absolute maximum lifetime (30 days) |
| `last_used_at` | bumped at most once per 30 minutes per session to avoid a write on every request |
| `revoked_at` | set on logout/revocation; non-NULL means invalid immediately |

The raw session token is handed to the client exactly once (as an `HttpOnly; Secure; SameSite=Lax` cookie) and is never stored, logged, or returned again; the database keeps only its SHA-256 hash. Redis may cache `last_used_at`/presence but is **not** the source of truth for sessions.

Session lifecycle decisions (locked):

- Absolute maximum lifetime: **30 days** (`expires_at`).
- `last_used_at` is bumped **at most once every 30 minutes** per session — this is a write-amplification optimization, **not** an idle timeout. There is **no automatic idle logout**; a session stays valid within its absolute lifetime until logout/revocation.
- **Maximum 10 active sessions per account**; issuing an 11th revokes the oldest active session.
- Logout or revocation invalidates the session **immediately** (revoke row + clear cookie).
- On a privilege/credential change (password change, device revocation), the affected sessions are rotated: new session ID issued, old row revoked — preventing session fixation.

### Pairing codes (node bootstrap)

The `pairing_codes` table stores **only the SHA-256 hash** of a pairing code. The
plaintext code is shown to the user exactly once (in the web UI), is **never
logged or persisted**, and is consumed atomically on first successful redemption.
Kept separate from `sessions` and `pairing_sessions` (device↔node local pairing).

| Column | Notes |
|---|---|
| `code_hash` | PK — SHA-256 of the normalized code (`NODUS-7K4P-92XM`) |
| `account_id` | FK → `accounts`; the account that issued the code |
| `status` | `PENDING` / `CONSUMED` / `REVOKED` |
| `node_id` | FK → `storage_nodes`; set on successful redemption |
| `created_at` | set on issue |
| `expires_at` | ~15-minute lifetime |
| `consumed_at` | set atomically on redemption; retained for auditability |

The code is a **bootstrap credential only** — permanent node trust remains the
node's Ed25519 challenge-response (§8). Full flow: §7b; API: §7b;
migration: `009_pairing_codes`.

### Redis

Keep Redis for ephemeral Relay state:

```text
presence
heartbeats
pending notifications
temporary buffer metadata
TTL management
WebSocket-related ephemeral state
```

### Relay Buffer

The encrypted shard buffer is temporary.

Lifecycle:

```text
Client
  |
  v
Relay buffer
  |
  v
Storage Node receives
  |
  v
Node verifies and commits
  |
  v
Relay deletes temporary copy
```

Relay buffering is not considered permanent backup storage.

---

## 14. Three Local/Remote Metadata Stores

There are effectively three metadata stores:

| Location | Purpose | Internet Required |
|---|---|---|
| Relay PostgreSQL | Account/control-plane replica | Yes for remote access |
| Rust SQLite | Authoritative local node state | No |
| Client local DB | Cached catalog, credentials, trusted nodes, sync state | No |

They are not direct database replicas.

---

## 15. Event-Based Synchronization

Do not synchronize database snapshots during normal operation.

Synchronize operations/events.

Example:

```json
{
  "event_id": "uuid",
  "origin_id": "node_abc",
  "origin_sequence": 1042,
  "type": "FILE_CREATED",
  "payload": {}
}
```

Every side keeps track of which events it has seen.

### Rust outbox

```text
sync_outbox

event_id
origin_id
origin_sequence
event_type
payload
created_at
synced
```

### Idempotency

Events must be safe to resend.

If the network fails after the Relay applies an event but before the acknowledgement reaches Rust:

```text
Rust -> Relay: event X
Relay: applies X
ACK lost
Rust -> Relay: event X again
Relay: already processed
```

No duplicate state is created.

---

## 16. Offline Divergence Example

Initial state:

```text
Relay = A B
Node  = A B
```

Node goes offline.

User uploads C locally:

```text
Node:
A B C

Node event:
+ C
```

Relay comes online while Node remains offline.

Another device uploads D:

```text
Relay:
A B D

Relay event:
+ D
```

When the Node reconnects:

```text
Node -> Relay:
+ C

Relay -> Node:
+ D
```

Final:

```text
Relay = A B C D
Node  = A B C D
```

The system does not choose a database winner. It synchronizes missing operations.

---

## 17. Real Conflicts

Independent additions are not conflicts.

Actual conflicts can occur when two devices modify the same logical file.

For the initial implementation, avoid CRDT complexity.

Treat files as immutable versions:

```text
file_123
 |
 +-- version_1
 +-- version_2A
 +-- version_2B
```

If two concurrent versions conflict:

```text
CONFLICT
```

Keep both versions and let the user resolve them.

### Deletes

Represent deletion using tombstones:

```text
FILE_DELETED(file_id)
```

Do not simply remove all knowledge of the file, or an old offline device could accidentally resurrect it.

---

## 17a. Conflict Resolution UX

"Keep both versions and let the user resolve them" (§17) needs a concrete mechanism.
Proposed default for v1, modeled on the approach used by Dropbox/Syncthing-style
tools rather than inventing something novel:

```text
CONFLICT detected on file_123
      |
      v
Keep version_2A at original path
Keep version_2B as a sibling:
   "filename (conflicted copy, Device B, 2026-08-31).ext"
      |
      v
Surface a non-blocking notification in the client
   ("2 files need review") rather than a blocking modal
      |
      v
User manually deletes/merges the copy they don't want
```

This avoids building a merge UI for v1 (file contents are opaque encrypted blobs
to the client in most cases, so a diff/merge view isn't meaningful for non-text
files anyway). Revisit only if usage data shows conflicts are frequent enough
to justify more.

---

## 18. Sync Cursors

Use independent sequences.

Example:

```text
Node sequence:
node_abc:1042

Relay sequence:
relay:92831
```

Each event should also have a globally unique `event_id`.

A synchronization handshake exchanges cursors:

```text
SYNC_HELLO
    |
    v
SYNC_STATUS
    |
    +-- Node missing Relay events
    |
    +-- Relay missing Node events
    |
    v
EVENT_BATCH exchange
    |
    v
Acknowledgements
```

---

## 19. Full Relay Rebuild

The Relay database must be rebuildable.

If:

```text
Relay PostgreSQL
        X
```

deploy an empty database:

```text
PostgreSQL
    |
    v
empty
```

Then a Rust node can perform:

```text
FULL REBUILD / SNAPSHOT
```

The Rust node provides:

1. Current metadata snapshot
2. Physical object inventory
3. Checksums
4. Signed snapshot metadata

The Relay reconstructs PostgreSQL from this information.

---

## 20. Snapshot Protocol

Suggested flow:

```text
Relay
 |
 | REBUILD_REQUIRED
 v
Rust Node
 |
 | SNAPSHOT_BEGIN
 v
Relay
 |
 | SNAPSHOT_CHUNK
 | SNAPSHOT_CHUNK
 | SNAPSHOT_CHUNK
 v
Relay
 |
 | SNAPSHOT_END
 v
Validate
 |
 v
Promote rebuilt state
```

Snapshot metadata should include:

```text
snapshot_id
node_id
sequence/checkpoint
content_hash
signature
schema_version
```

The Relay verifies the snapshot using the Storage Node's trusted public key.

---

## 21. Physical Reconciliation

The Rust node must distinguish logical metadata from actual disk state.

Example:

```text
SQLite:
object_123 exists

Disk:
object_123 missing
```

This is divergence.

Periodically run reconciliation:

```text
SQLite metadata
      +
physical object inventory
      |
      v
Reconciled node state
```

For a first implementation, a straightforward inventory scan is sufficient.

A Merkle-tree-based inventory can be added later for large stores.

### 21a. Repair Actions on Divergence

Detecting `object_123 exists in SQLite but missing on disk` is only half the job.
Define the repair action per divergence type before implementing reconciliation:

```text
Metadata says exists, disk missing
      |
      v
Mark object DEGRADED
      |
      v
Attempt re-fetch from a peer that has it (another device, or Relay buffer
if not yet cleaned up) — otherwise mark PERMANENTLY_MISSING and surface to user

Disk has object, metadata missing (orphan)
      |
      v
Safe to garbage-collect after a grace period (could be a write that crashed
mid-commit) — do not delete immediately

Content hash mismatch (corruption)
      |
      v
Mark object DEGRADED, same re-fetch path as "disk missing"
```

Silent detection without a repair path just moves the problem to a log file
nobody reads.

---

## 22. Important Relay-Buffer Rule

A Relay buffer entry that isn't present in a Rust snapshot is not automatically deleted.

Example:

```text
Rust:
A B C

Relay buffer:
D
```

D may be a pending delivery.

Therefore distinguish:

```text
D
 |
 +-- pending relay delivery
 +-- durable node data
 +-- acknowledged
 +-- deleted
```

A full node snapshot describes:

> What the Node currently owns.

It does not mean:

> Delete every Relay-buffer object absent from this snapshot.

---

## 23. File State Machine

Suggested state machine:

```text
CREATED
   |
   v
UPLOADING
   |
   v
RELAY_BUFFERED
   |
   v
NODE_RECEIVING
   |
   v
NODE_VERIFIED
   |
   v
NODE_STORED
   |
   v
RELAY_CLEANUP
```

A file/shard should only become `NODE_STORED` after the Rust node has:

- received the data
- verified integrity
- persisted the object
- committed the metadata

---

## 24. Lost Phone / New Device

Normal case:

```text
Account
 |
 +-- Phone A
 +-- Laptop
 +-- Rust Node
```

Phone A is lost.

New Phone B:

```text
New Phone B
     |
     v
Authenticate / Recovery
     |
     v
Discover Rust Node locally
     |
     v
Authenticate Node
     |
     v
Recover authorized key material
     |
     v
Register New Phone B
```

The Rust node should be able to support local recovery when Internet is unavailable, subject to the final recovery-key design.

---

## 25. Key Envelopes

Do not store raw file encryption keys on the Relay.

Conceptually:

```text
File Encryption Key
        |
        +-- encrypted for Device A
        +-- encrypted for Device B
        +-- encrypted for Storage Node
```

The Relay stores encrypted key envelopes.

It does not possess the plaintext File Encryption Keys.

The exact key hierarchy and recovery protocol remain a design item to finalize before implementation.

---

## 26. Control Plane vs Storage Plane

Keep these separate.

### Control Plane

```text
accounts
devices
nodes
file catalog
locations
key envelopes
sync metadata
```

### Storage Plane

```text
encrypted shards
objects
physical disk
```

The Relay should primarily provide the control plane and temporary transport buffering.

The Rust node owns the physical storage plane.

---

## 27. Failure Guarantees

The architecture should guarantee:

### Offline operation

```text
Internet unavailable
        |
        v
Local client <-> Rust Node continues working
```

### Incremental synchronization

```text
Disconnected changes
        |
        v
Durable events
        |
        v
Synchronize when connected
```

### Relay recoverability

```text
Relay PostgreSQL lost
        |
        v
Rust nodes provide snapshots/inventory
        |
        v
Relay metadata rebuilt
```

### Reconciliation

```text
Logical metadata
       +
Physical inventory
       |
       v
Detect/repair divergence
```

---

## 28. Implementation Order

Build the system incrementally.

```text
0. Foundational design decisions (§0): key hierarchy, recovery,
   conflict UX, mobile discovery approach, GC policy
          |
1. Repository / Turborepo
          |
2. Core types + shard format
          |
3. Encryption + BLAKE3
          |
4. Protocol package
          |
5. Rust SQLite schema
          |
6. Rust object store
          |
7. Go Relay + PostgreSQL + Redis
          |
7a. Opaque server-side session auth (see auth-migration checklist in `Todo.md`):
     replace JWT/refresh-token auth in the Relay backend and auth API, then
     Next.js integration, then pairing/device auto-registration, then Rust
     Storage Node verification, then security + client tests
          |
 7b. Self-hosted Storage Node bootstrap pairing (§7b/§7c): pairing_codes
     migration (009) + generation + atomic redemption in the Relay reusing
     the first-node/`is_primary` rule, Rust `nodus node pair` CLI + relay_url
     config precedence, Devices-page "+ Add Storage Node" dialog + polling,
     PUBLIC_RELAY_URL deployment unit, then Go/Rust/Web/E2E tests
          |
 8. Rust <-> Relay incremental sync
          |
9. Full snapshot / Relay rebuild
          |
10. Buffer-and-Relay transfer
          |
11. Local discovery + node authentication
          |
12. WebRTC direct transfer
          |
13. Transfer Manager / path selection
          |
14. Next.js client
          |
15. Expo client
          |
16. Device/key recovery
          |
17. Mobile background sync
          |
18. Failure/recovery/stress testing
```

Do not start with the UI. The distributed storage, synchronization, identity, and transport layers are the difficult parts.

Dependency note for stage 7b: it depends on 7a (opaque sessions) and the
`storage_nodes` registration semantics; it precedes stage 8 (incremental sync)
and stage 11 (local discovery). QR-based pairing stays deferred (v1 non-goal).

---

## 29. Remaining Design Decisions

Before implementation, finalize these:

### Authentication and Session (resolved for opaque server-side sessions)

- **No JWTs, no access tokens, no refresh tokens, no Better Auth/Clerk/Auth0.** Account auth is a server-side opaque session ID (32 random bytes → base64url), delivered as an `HttpOnly; Secure; SameSite=Lax` cookie, stored in PostgreSQL only as a SHA-256 hash (see §13).
- **Session lifetime:** 30-day absolute maximum; `last_used_at` bumped at most once per 30 minutes (write-amplification optimization, **not** an idle logout — no automatic idle timeout); immediate invalidation on logout/revocation; max 10 active sessions/account (11th revokes oldest).
- **Device binding:** every session requires a `device_id` (FK → devices). Devices are **auto-registered on first login** — the client generates a device keypair and registers it alongside session creation, so a user need not manually pair before they can authenticate.
- **WebSocket auth:** the browser WebSocket handshake authenticates via the session **cookie**; `?token=<JWT>` is removed entirely. Rust Storage Node WebSocket/HTTP auth stays on its cryptographic challenge-response / signed-request mechanism (unchanged).
- **Session fixation:** rotate the session ID (new row, revoke old) on privilege/credential change.
- **API shape:** `POST /auth/register`, `POST /auth/login`, `GET /auth/session`, `POST /auth/logout`. `/auth/refresh` is removed.

### Cryptography
- Exact account/device/node key hierarchy
- Key agreement mechanism
- File-key envelope format
- Recovery-key mechanism
- Device revocation

### Synchronization
- Exact event schema
- Cursor semantics
- Event ordering
- Conflict handling
- Tombstone retention
- Snapshot format
- Reconciliation protocol

### Storage
- SQLite schema
- Object-store layout
- Atomic file writes
- Crash recovery
- Disk integrity checks
- Garbage collection (see §29a below for a proposed starting policy)

### Networking
- Local signaling authentication
- WebRTC authentication binding
- mDNS service format
- Pairing/QR format — **resolved**: account↔node bootstrap is the pairing-code
  flow (§7b, `NODUS-XXXX-XXXX`); QR-based pairing is a **v1 non-goal** and, if
  added later, must encode `{relay_url, code}` and reuse the same redemption
- Local (Wi-Fi/LAN) endpoint security

### Mobile
- Background sync approach
- Managed Expo vs native Android service
- Offline database/cache strategy

---

## 29a. Garbage Collection Policy (Proposed Starting Point)

With immutable versions + tombstones + content-addressed objects, storage grows
monotonically unless something prunes it. Proposed defaults for v1 (make each of
these configurable per-account rather than hardcoded):

```text
Old file versions
      |
      v
Keep N most recent versions per file (default: 5), OR keep versions
younger than T days (default: 30) — whichever policy the user picks

Tombstones
      |
      v
Retain for a fixed window (default: 90 days) to prevent resurrection by a
long-offline device, then compact

Orphaned objects (no metadata reference)
      |
      v
Grace period (default: 24h) before deletion, per §21a

Relay temporary buffer
      |
      v
Already time-boxed by design (§13) — not part of this policy
```

Run GC as a periodic Rust-node background job, not inline with writes, so it
never blocks a foreground transfer.

---

## 30. Target Architecture Summary

```text
                         INTERNET
                            |
                            v
                 +----------------------+
                 |      GO RELAY        |
                 |                      |
                 | Control/API          |
                 | PostgreSQL            |
                 | Redis                 |
                 | Temporary Buffer      |
                 +----------+-----------+
                            |
                     Event Sync / Rebuild
                            |
                            v
                 +----------------------+
                 |    RUST STORAGE      |
                 |        NODE          |
                 |                      |
                 | SQLite               |
                 | Event Log            |
                 | Object Store         |
                 | Node Identity        |
                 | Reconciliation       |
                 +----------+-----------+
                            ^
                            |
                 Wi-Fi/LAN / WebRTC / mDNS
                            |
                 +----------+-----------+
                 |                      |
              Next.js                Expo
               Web                  Mobile
```

### Core design principle

**Internet is an enhancement, not a dependency.**

```text
Internet available:
Client <-> Relay <-> Rust Node

Internet unavailable:
Client <-> Rust Node

Rust Node offline:
Client -> Relay Buffer -> Rust Node

Relay corrupted:
Rust Node -> Snapshot/Rebuild -> New Relay DB
```

The result is an offline-first storage system where the Relay can fail, devices can disconnect for long periods, and independently created changes can converge without treating either database as an unquestionable global source of truth.
