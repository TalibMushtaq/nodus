# TODO — Nodus (Hybrid Offline-First P2P Storage System)

Derived from `nodus_implementation_plan.md`. Ordered to match §28 Implementation
Order, with §0's foundational decisions pulled in front of everything else since
later steps assume they're settled.

Checkboxes are for tracking; nest sub-tasks as you break work down further.

---

## Phase 0 — Foundational Design Decisions (blocking — do not skip)

- [ ] **Key hierarchy**: define Account → Device → Storage Node key relationships
  - [ ] Choose key agreement mechanism (e.g. X25519)
  - [ ] Define File Encryption Key envelope format (§25) — one envelope per
        authorized device/node
  - [ ] Define device revocation flow (remove a device's envelope access
        without rotating every file key, or accept rotation cost)
- [ ] **Recovery-key mechanism** (§9, §24)
  - [ ] Decide recovery credential type (recovery phrase, secondary device
        approval, social recovery — pick one for v1)
  - [ ] Define what happens when the *only* trusted device is lost with no
        Internet available (local-only recovery via Storage Node, §24)
- [ ] **Conflict-resolution UX** (§17a)
  - [ ] Confirm "conflicted copy" file-naming approach
  - [ ] Decide notification style (non-blocking banner vs. inbox/list view)
- [ ] **Mobile local-discovery approach** (§7a)
  - [ ] Decide managed Expo vs. bare/native workflow for mDNS + WebRTC
  - [ ] Decide foreground-only vs. background-attempt policy for Path A
  - [ ] Design the UX for local-network permission denial
- [ ] **Garbage-collection policy** (§29a)
  - [ ] Confirm default retention numbers (version count/age, tombstone window,
        orphan grace period) — configurable per account
- [ ] Write these decisions up as short ADRs (Architecture Decision Records) in
      `docs/decisions/` before touching code

---

## Phase 1 — Monorepo & Tooling

- [ ] Create the single `nodus` monorepo (protocol, sdk, web, mobile, node,
      relay all live in this one repo — see plan §2)
- [ ] Set up `pnpm-workspace.yaml` + `turbo.json` for the TypeScript side
      (`apps/web`, `apps/mobile`, `packages/*` only — Rust/Go under `services/`
      stay outside Turborepo's scope, per §3a)
- [ ] Set up base CI with path-scoped jobs (lint/build/test), so a Rust-only
      change doesn't trigger the full TS pipeline and vice versa
- [ ] Set up `docs/architecture/`, `docs/protocol/`, `docs/security/`,
      `docs/decisions/` skeletons and commit the Phase 0 ADRs

## Phase 2 — Core Types & Shard Format

- [ ] `packages/core`: file/shard domain types (no React/Next/Expo/RN deps)
- [ ] Implement 8 MB shard splitting
- [ ] Implement shard reconstruction
- [ ] Define shard metadata format (shard index, file_id, hash, size)

## Phase 3 — Encryption & Integrity

- [ ] Implement AES-256-GCM encrypt/decrypt for shards, unique nonce per shard
- [ ] Implement BLAKE3 hashing for shard integrity
- [ ] Implement File Encryption Key generation + envelope encryption
      (per Phase 0 key hierarchy decision)
- [ ] Unit tests: round-trip encrypt→decrypt, tamper detection via BLAKE3

## Phase 4 — Protocol Package

- [ ] `packages/protocol`: define all message types (register, heartbeat,
      webrtc_offer/answer/ice_candidate, shard_upload/ack, pending_notify,
      shard_fetch/delete, sync_hello/status, event_batch, snapshot_begin/
      chunk/end, reconcile)
- [ ] Add runtime validation (not just TS types) — e.g. zod or similar
- [ ] Document schema versioning strategy in `docs/protocol/`

## Phase 5 — Rust: SQLite Schema

- [ ] Design tables: `files`, `file_versions`, `shards`, `storage_objects`,
      `devices`, `trusted_nodes`, `sync_events`, `sync_outbox`,
      `sync_cursors`, `tombstones`
- [ ] Write migrations
- [ ] Node identity: generate persistent keypair, derive Node ID, store under
      `~/.nodus/identity/`

## Phase 6 — Rust: Object Store

- [ ] Content-addressed object layout under `~/.nodus/objects/<prefix>/`
- [ ] Atomic writes (write-temp-then-rename) + crash recovery path
- [ ] Implement reconciliation scan (§21) with repair actions (§21a):
      DEGRADED / re-fetch-from-peer / orphan grace period / corruption handling
- [ ] Implement GC background job per §29a policy

## Phase 7 — Go Relay: Control Plane

- [ ] PostgreSQL schema: `accounts`, `devices`, `storage_nodes`, `files`,
      `file_versions`, `file_locations`, `key_envelopes`, `sync_events`,
      `sync_cursors`, `tombstones`
- [ ] Redis: presence, heartbeats, pending notifications, temp buffer
      metadata + TTL, WebSocket ephemeral state
- [ ] Relay temporary buffer lifecycle (accept → hold → deliver → delete on
      node ack, §13)
- [ ] Auth/account service (registration, login, device registration)

## Phase 8 — Rust ↔ Relay Incremental Sync

- [ ] Implement `sync_outbox` draining from Rust to Relay
- [ ] Implement event application with idempotency (dedupe by `event_id`)
- [ ] Implement `SYNC_HELLO` / `SYNC_STATUS` cursor-exchange handshake (§18)
- [ ] Test the offline-divergence scenario from §16 end-to-end
      (two independent additions converge without a "winner")

## Phase 9 — Full Snapshot / Relay Rebuild

- [ ] Implement `SNAPSHOT_BEGIN` / `SNAPSHOT_CHUNK` / `SNAPSHOT_END` flow (§20)
- [ ] Snapshot metadata: snapshot_id, node_id, sequence/checkpoint,
      content_hash, signature, schema_version
- [ ] Relay-side snapshot verification against trusted node public key
- [ ] Enforce the "relay buffer entry not in snapshot ≠ delete" rule (§22)
- [ ] Test: wipe a scratch PostgreSQL instance, rebuild fully from a Rust node

## Phase 10 — Buffer-and-Relay Transfer (Path C)

- [ ] Client → Relay buffer upload
- [ ] Relay → Storage Node asynchronous delivery when node comes online
- [ ] Node verify + commit → Relay deletes temp copy
- [ ] File state machine transitions: CREATED → UPLOADING → RELAY_BUFFERED →
      NODE_RECEIVING → NODE_VERIFIED → NODE_STORED → RELAY_CLEANUP (§23)

## Phase 11 — Local Discovery & Node Authentication

- [ ] mDNS advertisement (Rust node) + discovery (clients)
- [ ] First-time pairing flow: account auth → Relay auth → pair node →
      establish identities, QR-based where possible (§7)
- [ ] Subsequent offline auth: known Node ID? → challenge-response →
      verify signature → authenticated
- [ ] Apply Phase 0 mobile-discovery decision (foreground/background policy,
      Expo vs. native)

## Phase 12 — WebRTC Direct Transfer

- [ ] `packages/webrtc-transport`: peer connection, SDP offer/answer, ICE,
      DataChannel, streaming
- [ ] Path A (direct local signaling + WebRTC) — no Relay involved
- [ ] Path B (Relay-mediated signaling + direct WebRTC) — Relay carries
      SDP/ICE only, never file data

## Phase 13 — Transfer Manager

- [ ] Implement fallback chain: Local signaling → Direct WebRTC → (on
      failure) Relay signaling → Direct WebRTC → (on failure)
      Buffer-and-Relay → (Relay unavailable) Local persistent queue
- [ ] Bounded timeouts + exponential backoff at each stage
- [ ] Benchmark the ~4s WebRTC negotiation timeout against real Wi-Fi/NAT
      conditions (not just LAN-in-a-lab) before locking it in

## Phase 14 — Next.js Web Client

- [ ] `packages/relay-client`: WebSocket connection, reconnection, heartbeats,
      message routing, presence
- [ ] Client local DB (cached catalog, credentials, trusted nodes, sync state)
- [ ] Browser-specific WebRTC/mDNS handling, with fallback UX when local
      network access is unavailable

## Phase 15 — Expo Mobile Client

- [ ] Reuse `packages/sdk` where portable; native/mobile-specific pieces
      per Phase 0 decision
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

- [ ] Exact sync event schema (needed by Phase 8)
- [ ] Event ordering guarantees (needed by Phase 8)
- [ ] Tombstone retention window — final number (needed by Phase 9, informs §29a)
- [ ] LAN-only endpoint security details (needed by Phase 11)
- [ ] Pairing/QR format spec (needed by Phase 11)
