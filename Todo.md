# TODO — Nodus (Hybrid Offline-First P2P Storage System)

Derived from `nodus_implementation_plan.md`. Ordered to match §28 Implementation
Order, with §0's foundational decisions pulled in front of everything else since
later steps assume they're settled.

Checkboxes are for tracking; nest sub-tasks as you break work down further.

---

## Phase 0 — Foundational Design Decisions (blocking — do not skip)

- [x] **Key hierarchy**: define Account → Device → Storage Node key relationships — see docs/decisions/0001-key-hierarchy.md
  - [x] Choose key agreement mechanism (e.g. X25519) — see docs/decisions/0001-key-hierarchy.md
  - [x] Define File Encryption Key envelope format (§25) — one envelope per authorized device/node — see docs/decisions/0001-key-hierarchy.md
  - [x] Define device revocation flow (remove a device's envelope access without rotating every file key, or accept rotation cost) — see docs/decisions/0001-key-hierarchy.md
- [x] **Recovery-key mechanism** (§9, §24) — see docs/decisions/0002-recovery-mechanism.md
  - [x] Decide recovery credential type (recovery phrase, secondary device approval, social recovery — pick one for v1) — see docs/decisions/0002-recovery-mechanism.md
  - [x] Define what happens when the *only* trusted device is lost with no Internet available (local-only recovery via Storage Node, §24) — see docs/decisions/0002-recovery-mechanism.md
- [x] **Conflict-resolution UX** (§17a) — see docs/decisions/0003-conflict-resolution-ux.md
  - [x] Confirm "conflicted copy" file-naming approach — see docs/decisions/0003-conflict-resolution-ux.md
  - [x] Decide notification style (non-blocking banner vs. inbox/list view) — see docs/decisions/0003-conflict-resolution-ux.md
- [x] **Mobile local-discovery approach** (§7a) — see docs/decisions/0004-mobile-local-discovery.md
  - [x] Decide managed Expo vs. bare/native workflow for mDNS + WebRTC — see docs/decisions/0004-mobile-local-discovery.md
  - [x] Decide foreground-only vs. background-attempt policy for Path A — see docs/decisions/0004-mobile-local-discovery.md
  - [x] Design the UX for local-network permission denial — see docs/decisions/0004-mobile-local-discovery.md
- [x] **Garbage-collection policy** (§29a) — see docs/decisions/0005-garbage-collection-policy.md
  - [x] Confirm default retention numbers (version count/age, tombstone window, orphan grace period) — configurable per account — see docs/decisions/0005-garbage-collection-policy.md
- [x] Write these decisions up as short ADRs (Architecture Decision Records) in `docs/decisions/` before touching code

---

## Phase 1 — Monorepo & Tooling

- [x] Create the single `nodus` monorepo (protocol, sdk, web, mobile, node,
      relay all live in this one repo — see plan §2)
- [x] Set up `pnpm-workspace.yaml` + `turbo.json` for the TypeScript side
      (`apps/web`, `apps/mobile`, `packages/*` only — Rust/Go under `services/`
      stay outside Turborepo's scope, per §3a)
- [x] Set up base CI with path-scoped jobs (lint/build/test), so a Rust-only
      change doesn't trigger the full TS pipeline and vice versa
- [x] Set up `docs/architecture/`, `docs/protocol/`, `docs/security/`,
      `docs/decisions/` skeletons and commit the Phase 0 ADRs

## Phase 2 — Core Types & Shard Format

- [x] `packages/core`: file/shard domain types (no React/Next/Expo/RN deps)
- [x] Implement 8 MB shard splitting
- [x] Implement shard reconstruction
- [x] Define shard metadata format (shard index, file_id, hash, size)

## Phase 3 — Encryption & Integrity

- [x] Implement AES-256-GCM encrypt/decrypt for shards, unique nonce per shard
- [x] Implement BLAKE3 hashing for shard integrity
- [x] Implement File Encryption Key generation + envelope encryption
      (per Phase 0 key hierarchy decision)
- [x] Unit tests: round-trip encrypt→decrypt, tamper detection via BLAKE3

## Phase 4 — Protocol Package

- [x] `packages/protocol`: define all message types (register, heartbeat,
      webrtc_offer/answer/ice_candidate, shard_upload/ack, pending_notify,
      shard_fetch/delete, sync_hello/status, event_batch, snapshot_begin/
      chunk/end, reconcile)
- [x] Add runtime validation (not just TS types) — e.g. zod or similar
- [x] Document schema versioning strategy in `docs/protocol/`

## Phase 5 — Rust: SQLite Schema

- [x] Design tables: `files`, `file_versions`, `shards`, `storage_objects`,
      `devices`, `trusted_nodes`, `sync_events`, `sync_outbox`,
      `sync_cursors`, `tombstones`
- [x] Write migrations
- [x] Node identity: generate persistent keypair, derive Node ID, store under
      `~/.nodus/identity/`

## Phase 5a — Rust: Storage Node Setup & Config

- [x] `src/config/` module:
  - [x] First-run detection (`~/.nodus/config.toml` exists?)
  - [x] Unattended install: `--data-dir` CLI flag and `NODUS_DATA_DIR` env var
  - [x] Interactive prompt via `dialoguer` with default `~/NodusBackup`
  - [x] Path validation (writable, create-if-missing)
  - [x] Non-blocking warnings: cloud-sync folders, removable/network mounts
  - [x] Blocking warning: existing `nodus.db` or `objects/` in target dir
  - [x] Write/read `~/.nodus/config.toml` (TOML key: `data_dir`)
- [x] Add dependencies: `dialoguer`, `directories`, `toml`
- [x] Document v1 scope boundary: no post-setup `data_dir` change

## Phase 6 — Rust: Object Store

- [x] Content-addressed object layout under `<data_dir>/objects/<prefix>/`
- [x] Atomic writes (write-temp-then-rename) + crash recovery path
- [x] Implement reconciliation scan (§21) with repair actions (§21a):
      DEGRADED / re-fetch-from-peer / orphan grace period / corruption handling
- [x] Implement GC background job per §29a policy

## Phase 7 — Go Relay: Control Plane

- [x] PostgreSQL schema: `accounts`, `devices`, `storage_nodes`, `files`,
      `file_versions`, `file_locations`, `key_envelopes`, `sync_events`,
      `sync_cursors`, `tombstones`
- [x] Redis: presence, heartbeats, pending notifications, temp buffer
      metadata + TTL, WebSocket ephemeral state
- [x] Relay temporary buffer lifecycle (accept → hold → deliver → delete on
      node ack, §13)
- [x] Auth/account service (registration, login, device registration)

## Phase 7a — Opaque Server-Side Session Auth Migration (new, plan §8/§13/§29)

Replace account auth's JWT/refresh-token model with **opaque, randomly
generated server-side sessions** (PostgreSQL stores only SHA-256 hashes;
cookie = `HttpOnly; Secure; SameSite=Lax`). This is a migration of the *auth
layer only* — device identity (asymmetric key), Storage Node identity
(Ed25519 challenge-response) and file encryption (key envelopes) are
**unchanged**.

### Non-goals (explicit)

- ❌ No JWTs, no access tokens, no refresh tokens anywhere in Nodus auth
- ❌ No auth frameworks (no Better Auth / Clerk / Auth0)
- ❌ No custom password/KDF primitives (Argon2id hash in `accounts.password_hash`
      stays as-is)
- ❌ No `POST /auth/refresh` route; `/auth/login`/`/auth/register` never return
      tokens in the response body
- ❌ No idle/logout after 30 minutes — the 30-min `last_used_at` bump is a
      write-amplification optimization only

### Locked session lifecycle (plan §13)

- Absolute maximum lifetime: **30 days** (`expires_at`)
- `last_used_at` bumped **at most once per 30 min** per session
- **Max 10 active sessions/account**; 11th issue revokes the oldest
- Logout/revocation invalidates **immediately**
- Session ID rotated (new row, old revoked) on privilege/credential change
- Every session **requires** a `device_id`; devices **auto-register on first
      login** (client generates device keypair and registers beside session
      creation — no manual pre-pairing to authenticate)

### 1. Relay backend

- [x] `services/relay/internal/auth/token.go`: remove `IssueAccessToken` /
      `ParseAccessToken` (JWT HS256) and refresh-token rotation; add session ID
      generation (32 random bytes → base64url, `crypto/rand`) and SHA-256
      `HashSession`
- [x] New `services/relay/internal/auth/session.go`: `CreateSession`,
      `LookupSession` (expiry/revoked check), `TouchSession` (last_used_at ≤
      once/30 min), `RevokeSession`, `RevokeAllForAccount`/`ForDevice`
- [x] `middleware.go`: rewrite `RequireAuth` to read the session cookie
      (`nodus_session`), hash it, look up `sessions`, populate
      `AccountID` + `DeviceID` in request context; drop JWT claims
- [x] `config.go`: remove `JWTSecret`/`JWTExpiry`/`RefreshExpiry`; add
      `SessionCookieName`, `SessionMaxAge` (30d), `SessionTouchInterval` (30m),
      cookie flags (HttpOnly/Secure/SameSite=Lax)
- [x] Migration `006_sessions.{up,down}.sql`: create `sessions`
      (`session_hash UNIQUE`, `account_id FK`, `device_id FK NOT NULL`,
      `created_at`, `expires_at`, `last_used_at`, `revoked_at`); **drop
      `refresh_tokens` outright** — no migration window, no dual auth model
- [x] `main.go` routes: `POST /auth/login|register`, `POST /auth/logout`,
      `GET /auth/session`; **remove `POST /auth/refresh`**
- [x] Verify Rust Storage Node WS/HTTP auth is untouched (challenge-response,
      signed requests) and unaffected by the JWT removal

### 2. Auth API

- [x] `internal/handler/auth.go`: `Login`/`Register` set the session cookie and
      return `{account_id, device_id, session_expires_at}` — no token in body
- [x] New `Session` handler: return current session info from cookie;
      401 when missing/expired/revoked
- [x] `Logout`: revoke the session row + clear cookie (`Max-Age=0`)
- [x] Device **auto-registration on first login**: generate device keypair
      client-side, `POST /devices/register` alongside session creation, bind
      `sessions.device_id`
- [x] Session fixation: rotate session ID (new row, revoke old) on password
      change / device revocation
- [x] Update `auth_test.go`, `token_test.go`, `middleware_test.go` to
      session-cookie tests; update `handler/*` tests that relied on Bearer

### 3. Next.js integration

- [x] Remove `better-auth` dependency
- [x] Route handlers `app/api/auth/{login,register,logout,session}/route.ts`
      proxying Relay + setting/clearing the HttpOnly/Secure/SameSite=Lax cookie
- [x] `lib/session.ts`: server `getSession()` / `requireAuth()` via Relay
      `GET /auth/session` using the cookie
- [x] `lib/auth-client.ts` + `useAuth()` hook; **remove all
      `sessionStorage`/`localStorage` JWT handling**
- [x] Route guards: `/` → `/overview` if authed else `/auth`; dashboard group
      requires a valid session
- [x] Single-page wizard auth (`AuthFlow` at `/auth`) wired to route handlers
      (no mock `setTimeout`)

### 4. Pairing

- [x] Unify `apps/web/app/pair` onto the session-cookie boundary: replace
      direct `Authorization: Bearer` + `sessionStorage` JWT with
      session-authenticated proxied calls
- [x] Confirm `packages/relay-client` fetches use the authenticated session
      (no Bearer construction client-side)

### 5. Security tests

- [x] Session expiry (past `expires_at` → 401)
- [x] Revocation (logout/revoke → 401, row `revoked_at` set)
- [x] Fixation (rotate on policy change; old ID invalid)
- [x] Cookie flags asserted (HttpOnly/Secure/SameSite=Lax, Secure in prod)
- [x] Hash-only storage (raw token never stored/returned; DB holds SHA-256)
- [x] Max-10-sessions eviction (11th issue revokes oldest)
- [x] Device-bound session (session without valid `device_id` rejected)
- [x] 30-min `last_used_at` throttle (no write-per-request)

### 6. Client tests

- [x] Web: login/register sets cookie, session persists across reload, session
      guard redirects when unauthenticated, logout clears cookie
- [x] Web: auto device-registration on first login (keypair + `device_id` in
      every session)
- [x] WebSocket: browser WS handshake authenticates via session cookie
      (`?token=` removed)
- [ ] Mobile (Phase 15 when reached): same session model via secure platform
      storage (requirement §8 identity matrix preserved)

## Phase 7b — Self-Hosted Storage Node Bootstrap via Pairing Code (plan §7b)

First-time **account → new Storage Node** association uses a short-lived,
single-use **pairing code** (e.g. `NODUS-7K4P-92XM`). The code is **only a
bootstrap credential** — permanent trust remains the node's persistent Ed25519
identity and the existing WebSocket challenge-response auth (§8) is unchanged.
This is distinct from the Phase 11 device↔node *local* pairing. Mirrors new plan
stage 7b in §28 (inserted between 7a and 8).

> Session-level progress for this phase lives in `bootstrap-pairing-TODO.md`
> (S1–S10). The `— Sn` suffixes below are the sessions owning each item; keep
> this list consistent with that tracker.

### Deployment model

- [ ] Single-origin self-hosted unit (Next.js + Go Relay + PostgreSQL + Redis)
      behind TLS/reverse proxy; `/api/*` and `/ws` → Relay, rest → Next.js
      (plan §3b) — S8
- [ ] `PUBLIC_RELAY_URL` operator-configured (never inferred from Host headers /
      Docker names / localhost); `ALLOWED_ORIGINS` aligned — S8

### Relay backend (migration 009)

- [x] Migration `009_pairing_codes.{up,down}.sql`: `pairing_codes` table
      (`code_hash` PK = SHA-256, `account_id` FK, `status` PENDING/CONSUMED/
      REVOKED, `node_id` FK, `created_at`, `expires_at`, `consumed_at`) +
      index on `account_id`; hash-only storage, consumed rows retained
- [x] `POST /pairing/codes` (`RequireAuth`): CSPRNG code, format `NODUS-XXXX-XXXX`
      (alphabet A-Z minus I/O + 2-9), ~15-min TTL; response `{code, expires_at}`;
      plaintext never logged
- [x] `POST /pairing/codes/redeem` (open — the code is the credential): normalize
      + hash → validate pending/not-expired/not-consumed → atomic single-use
      consume + upsert into `storage_nodes` bound to the account in one
      transaction, reusing the existing first-node/`is_primary` logic (see
      node.go); failures `code_unknown` (404) | `code_expired` (410) |
      `code_revoked` (410) | `code_consumed` (409) | `node_owned_elsewhere`
      (409); a rejected registration rolls back so the code is not burned
- [x] Per-IP rate limiter for `/pairing/codes/redeem` (mirror the Rust
      NonceStore/RateLimiter pattern); keys on client IP (port stripped,
      `TRUST_PROXY`-gated `X-Forwarded-For` behind the TLS reverse proxy)
- [x] `NodeAuthResultPayload.reason = "node_not_found"` for unpaired nodes so the
      node can print "Storage Node is not paired. Run: `nodus node pair`"

### Rust Storage Node (CLI + config)

- [x] Add `node` CLI subgroup with `nodus node start`; existing root flags keep
      booting the daemon as-is — S4
- [x] `nodus node pair` interactive (`dialoguer`) prompt for relay URL then code — S5
- [x] URL precedence: CLI `--relay` > `config.toml` `relay_url` >
      `NODUS_RELAY_URL` > **no default** (first-run never targets
      localhost/127.0.0.1) — S4
- [x] `nodus node pair --relay <url> --code <code>` scripted redeem over HTTPS — S5
- [x] Pair using the persistent Ed25519 identity (§5/§11) — never regenerate per
      attempt (plan §7c) — S5
- [x] Remove the `NODUS_RELAY_URL` localhost default; `nodus node start` uses
      config-precedence resolution (plan §11/§11a) — S4
- [x] Persist `relay_url` in `~/.nodus/config.toml` **only after successful
      pairing** — S5
- [x] Normal reconnect after pairing = existing WS challenge-response; the pairing
      code is never required again — S5 (live re-check in S10)

### Next.js web client

- [ ] Route handlers `app/api/pairing/codes/route.ts` and
      `app/api/pairing/codes/redeem/route.ts` proxying the Relay — S6
- [ ] `lib/pairing.ts`: `createPairingCode()`, node list/polling, revoke — S6
- [ ] Devices page "+ Add Storage Node" dialog: relay URL (`PUBLIC_RELAY_URL`) +
      code + expiry countdown + CLI instructions + node-status polling
      (connected/paired/expired/error states) — S7
- [ ] Keep internal `RELAY_URL` and user-facing `PUBLIC_RELAY_URL` distinct — S6

### Security tests

- [x] Go: full alphabet/format, expiry (past `expires_at` → `code_expired`),
      revoked (`code_revoked`), single-use (concurrent redemption → no
      double-claim; rejected registration leaves the code PENDING), unknown/
      consumed codes, node owned by another account (409), first-node
      `is_primary`, rate limiting, hash-only storage (no plaintext in DB/logs) — S1–S2
- [x] Rust: URL precedence, `relay_url` persistence on success-only, identity
      reuse across attempts, interactive + non-interactive pair, failure paths
      rendered as machine-readable reasons — S5
- [ ] Web: code creation, URL+code render, polling success/expiry, unpaired error — S7
- [ ] E2E: create code in UI → `nodus node pair` on a fresh node → node appears
      paired → WS challenge-response sync session succeeds — S10

### Non-goals (explicit)

- ❌ No QR-based pairing in v1 (later: encode `{relay_url, code}`, same redemption
      — update the Phase 14/15 QR items when it lands)
- ❌ No central/shared public Relay
- ❌ No automatic public-URL discovery; no Docker-internal hostnames exposed to nodes
- ❌ No node key rotation / complex re-pairing; the code is never a long-lived
      credential and is never needed after setup

## Phase 8 — Rust ↔ Relay Incremental Sync

- [x] Implement `sync_outbox` draining from Rust to Relay
- [x] Implement event application with idempotency (dedupe by `event_id`)
- [x] Implement `SYNC_HELLO` / `SYNC_STATUS` cursor-exchange handshake (§18)
- [x] Test the offline-divergence scenario from §16 end-to-end
      (two independent additions converge without a "winner")

## Phase 9 — Full Snapshot / Relay Rebuild

- [x] Implement `SNAPSHOT_BEGIN` / `SNAPSHOT_CHUNK` / `SNAPSHOT_END` flow (§20)
- [x] Snapshot metadata: snapshot_id, node_id, sequence/checkpoint,
      content_hash, signature, schema_version, cursor map
- [x] Relay-side snapshot verification against trusted node public key
- [x] Enforce the "relay buffer entry not in snapshot ≠ delete" rule (§22)
- [x] Test: wipe a scratch PostgreSQL instance, rebuild fully from a Rust node
- [x] `REBUILD_REQUIRED` relay→node request + primary-node routing queue
- [x] Rust snapshot builder + streaming (typed homogeneous chunks,
      `SNAPSHOT_CHUNK_MAX_RECORDS=1000`, per-node `snapshot_sequence`)
- [x] Atomic per-account promotion with FK drop/re-add (see
      `services/relay/internal/handler/promote.go`)

## Phase 10 — Buffer-and-Relay Transfer (Path C)

- [x] Client → Relay buffer upload (`POST /buffer/upload` — Relay handler completed)
- [x] Relay → Storage Node asynchronous delivery when node comes online
      (`GET /buffer/fetch` + `pending_notify` over WS; node pulls, verifies, commits)
- [x] Node verify + commit → Relay deletes temp copy (`shard_ack` `verified`/`failed`;
      buffer released on verified, kept + re-queued on failed)
- [x] File state machine transitions: CREATED → UPLOADING → RELAY_BUFFERED →
      NODE_RECEIVING → NODE_VERIFIED → NODE_STORED → RELAY_CLEANUP (§23) — enforced in
      Relay `file_locations.status`, no state collapsing
*(Note: Client-side integration and E2E moved to Phases 14/15)*

## Phase 11 — Local Discovery & Node Authentication

- [x] mDNS advertisement (Rust node)
- [x] First-time pairing flow, device↔node local trust (Node/Relay infrastructure): account auth → Relay auth → pair node (fast path + fallback)
      (account↔new-node bootstrap via pairing code is Phase 7b, plan §7b — not covered here)
- [x] Subsequent offline auth (Node infrastructure): known Node ID? → challenge-response → verify signature → authenticated
*(Note: UI flows, mDNS discovery, and mobile policies moved to Phases 14/15)*

## Phase 12 — WebRTC Direct Transfer

- [x] `packages/webrtc-transport`: peer connection, SDP offer/answer, ICE,
      DataChannel, streaming
- [x] Path A (direct local signaling + WebRTC) — no Relay involved
- [x] Path B (Relay-mediated signaling + direct WebRTC) — Relay carries
      SDP/ICE only, never file data

## Phase 13 — Transfer Manager

- [x] Implement fallback chain: Local signaling → Direct WebRTC → (on
      failure) Relay signaling → Direct WebRTC → (on failure)
      Buffer-and-Relay → (Relay unavailable) Local persistent queue
- [x] Bounded timeouts + exponential backoff at each stage
- [x] Benchmark the ~4s WebRTC negotiation timeout against real Wi-Fi/NAT
      conditions (not just LAN-in-a-lab) before locking it in
  - [x] `scripts/benchmark-webrtc`: timing contract (CLI) + real-network
        browser harness (bench.html); results → `docs/architecture/webrtc-benchmark-results.md`

## Phase 14 — Next.js Web Client

- [x] Scaffold Next.js application structure
- [x] `packages/relay-client`: WebSocket connection, reconnection, heartbeats, message routing, presence
  - [x] Shared backoff util (`packages/core/src/backoff.ts`)
  - [x] Connection state machine incl. `disconnected_max_retries`
  - [x] Auth-rejection close handling (Relay `4001` code + `onAuthError`)
  - [x] Heartbeat loop (`peerId` required at construction)
  - [x] Presence (send on connect, expose incoming via `on()`)
  - [x] Message subscription layer (`on`/`off`)
  - [x] React provider (`apps/web/providers/ws-provider.tsx`), StrictMode-safe
- [ ] Client-side uploader integration (Path C): shard the encrypted stream, emit sync events, and POST shards
- [ ] Wire-level e2e: real Rust `run_sync_session` against a live Relay + Next.js client uploader
- [x] First-time pairing flow (Web UI): "+ Add Storage Node" pairing-code dialog —
      show relay URL + code + expiry countdown, poll node status (plan §7b);
      **QR-based pairing deferred (non-goal)**
- [ ] Client local DB (cached catalog, credentials, trusted nodes, sync state)
- [ ] Browser-specific WebRTC/mDNS handling, with fallback UX when local network access is unavailable
 
## Phase 15 — Expo Mobile Client
 
- [ ] Scaffold Expo application structure
- [ ] Reuse `packages/sdk` where portable; native/mobile-specific pieces per Phase 0 decision
- [ ] mDNS discovery (Mobile) & Path A/B fallback logic
- [ ] First-time pairing flow (Mobile UI): pairing-code entry screens (plan §7b);
      **QR-based scanner deferred (non-goal)** — may later encode
      `{relay_url, code}` and reuse the same redemption
- [ ] Apply Phase 0 mobile-discovery decision (foreground/background policy, Expo vs. native)
- [ ] Local network permission prompt handling + denial fallback UX (§7a)

## Phase 16 — Device / Key Recovery

- [ ] Implement chosen recovery-key mechanism end-to-end
- [ ] Implement "lost phone → new phone" flow (§24): authenticate/recover →
      discover node locally → authenticate node → recover key material →
      register new device
- [ ] Test recovery with and without Internet available

## Phase 17 — Mobile Background Sync

- [ ] Implement background sync per Phase 0 decision (foreground service /
      WorkManager on Android; entitlement-gated background execution on iOS)
- [ ] Offline database/cache strategy for the mobile client

## Phase 18 — Failure / Recovery / Stress Testing

- [ ] Simulate: Internet unavailable (client ↔ node continues working)
- [ ] Simulate: Relay PostgreSQL loss → full rebuild from node snapshots
- [ ] Simulate: Node offline for an extended period → reconnect → full
      convergence via incremental sync
- [ ] Simulate: concurrent conflicting edits → conflicted-copy UX verified
- [ ] Simulate: disk corruption / missing objects → reconciliation repair
      path (§21a) exercised
- [ ] Load test Relay buffer under sustained Path C usage
- [ ] Security review pass: confirm Relay never sees plaintext file keys or
      shard contents, confirm revoked devices lose access without full
      account key rotation

---

## Open Items to Track Separately

These are called out in the plan as unresolved and don't block starting Phase 1,
but should be resolved before the phase that depends on them:

- [x] Exact sync event schema (needed by Phase 8) — **resolved in Phase 4**; see
      `packages/protocol/src/events/event-types.ts` and
      `docs/protocol/event-types.md`
- [x] Event ordering guarantees (needed by Phase 8) — **resolved in Phase 4**;
      `origin_id` + `origin_sequence` provide per-origin total ordering and
      cursor-based sync; see `docs/protocol/event-types.md` and
      `docs/protocol/message-catalog.md` (sync_hello/sync_status)
- [x] Tombstone retention window — final number (needed by Phase 9, informs §29a)
      — **resolved: 90 days** per `docs/decisions/0005-garbage-collection-policy.md`;
      enforced by the hourly prune in `services/relay/internal/tombstone/tombstone.go`
- [x] Local (Wi-Fi/LAN) endpoint security details (needed by Phase 11) — **resolved in Phase 11**; implemented rate limiting, nonce caps, and node_id cross-checking.
- [x] Pairing/QR format spec (needed by Phase 11) — **resolved in Phase 7b**:
      account↔node bootstrap pairing-code flow is canonical (`NODUS-XXXX-XXXX`,
      plan §7b); QR format deferred (non-goal)

- [ ] Replace the device private key stored in `localStorage` with a non-exportable WebCrypto Ed25519 key persisted in IndexedDB, and refactor the identity/signing API to use the key handle instead of exposing `private_key`.
