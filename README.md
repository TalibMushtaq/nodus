# Nodus

**Nodus** is a hybrid, offline-first peer-to-peer storage system. Files live
primarily on a storage node you control, sync directly between your own
devices over the local network, and use the Internet only as an enhancement —
never a hard dependency.

> 🚧 **Status: pre-implementation.** This repo currently contains the design
> and planning docs. See [Status & Roadmap](#status--roadmap) below before
> looking for code.

---

## Why Nodus

Most cloud storage treats the Internet — and a central server — as the
source of truth. Nodus flips that:

- **LAN-first.** Your devices talk directly to your Storage Node over the
  local network. No Internet required for day-to-day sync.
- **Internet as enhancement, not dependency.** A Relay server provides
  signaling, cross-network sync, and temporary buffering when devices aren't
  on the same network — but it never holds plaintext file contents or keys.
- **Recoverable by design.** If the Relay's database is lost, it can be
  fully rebuilt from snapshots held by your Storage Node(s).
- **Convergent, not "last write wins."** Independently made offline changes
  reconcile without an arbitrary winner overwriting the other.

## How it works

Four components, one protocol:

| Component | Role | Stack |
|---|---|---|
| **Web client** | Browser UI | Next.js |
| **Mobile client** | iOS / Android UI | React Native / Expo |
| **Storage Node** | Durable local storage, authoritative for its own data | Rust, SQLite |
| **Relay** | Internet-facing signaling, sync, auth, temporary buffering | Go, PostgreSQL, Redis |

```text
                         INTERNET
                            |
                            v
                 +----------------------+
                 |    Go Relay / API    |
                 | PostgreSQL · Redis   |
                 | Temporary Buffer     |
                 +----------+-----------+
                            |
                       Sync Protocol
                            |
                           LAN
                            |
                 +----------v-----------+
                 |   Rust Storage Node  |
                 | SQLite · Object Store|
                 +----------+-----------+
                            |
                     Local WebRTC
                            |
                 +----------v-----------+
                 |   Web / Mobile Client|
                 +----------------------+
```

Files are split into 8 MB shards, encrypted client-side with AES-256-GCM
(unique nonce per shard), and integrity-checked with BLAKE3. The Relay only
ever sees encrypted bytes and encrypted key envelopes — never plaintext file
keys or shard contents.

### Transfer paths

Nodus picks the best available path automatically, falling back as needed:

1. **Path A — Direct Local P2P.** Local signaling + WebRTC, no Relay involved.
2. **Path B — Relay-Mediated Signaling.** Relay carries SDP/ICE only; file
   data still flows peer-to-peer.
3. **Path C — Buffer-and-Relay.** Encrypted shard is buffered on the Relay
   and delivered asynchronously when the Storage Node comes back online.
4. **Path D — Local Queue.** If both the Storage Node and Relay are
   unreachable, changes queue locally until one becomes available.

## Repository layout

Nodus is a single monorepo — one repo, multiple languages:

```text
nodus/
├─ apps/
│  ├─ web/                 # Next.js web client
│  └─ mobile/               # React Native / Expo mobile client
├─ packages/
│  ├─ core/                 # Domain logic: sharding, crypto abstractions
│  ├─ protocol/              # Canonical protocol schemas/types
│  ├─ relay-client/          # WebSocket client (web + mobile)
│  ├─ webrtc-transport/      # WebRTC abstraction
│  └─ config/                 # Shared TypeScript tooling
├─ services/
│  ├─ relay/                 # Go Relay (control plane + buffer)
│  └─ storage-node/           # Rust Storage Node (data plane)
├─ infra/                    # Docker, compose, scripts
├─ docs/
│  ├─ architecture/
│  ├─ protocol/
│  ├─ security/
│  └─ decisions/             # ADRs
├─ tests/
│  ├─ integration/
│  └─ e2e/
├─ pnpm-workspace.yaml
└─ turbo.json
```

The TypeScript apps and packages are managed by Turborepo + pnpm. The Rust
Storage Node and Go Relay live in the same repository under `services/` but
sit outside the pnpm/Turborepo workspace, with their own native tooling.

## Status & Roadmap

Nothing is implemented yet. Before any code is written, five foundational
design decisions have to be locked in on paper (see `docs/decisions/` once
ADRs exist):

1. Key hierarchy & recovery-key mechanism
2. Conflict-resolution UX
3. Mobile local-discovery approach
4. Reconciliation repair action
5. Garbage-collection policy

Full build order and detailed task breakdown:

- [`nodus_implementation_plan.md`](./nodus_implementation_plan.md) — the
  complete architecture and design plan (protocol, schemas, key envelopes,
  state machines, failure guarantees, etc.)
- [`Todo.md`](./Todo.md) — the phase-by-phase implementation checklist
  derived from the plan

## Core design principle

> Internet is an enhancement, not a dependency.

```text
Internet available:     Client <-> Relay <-> Storage Node
Internet unavailable:   Client <-> Storage Node
Storage Node offline:   Client -> Relay Buffer -> Storage Node
Relay corrupted:        Storage Node -> Snapshot/Rebuild -> New Relay DB
```

## License

most probably MIT or GNU 