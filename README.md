# Nodus

**Nodus** is a hybrid, offline-first peer-to-peer storage system. Files live
primarily on a storage node you control, sync directly between your own
devices over the local network, and use the Internet only as an enhancement —
never a hard dependency.

> 🚀 **Status: active implementation.** Core storage, sync, and transit
> components are built and tested; the web client has a working UI ported from
> the design prototype. See [Current status](#current-status) below.

---

## Why Nodus

Most cloud storage treats the Internet — and a central server — as the
source of truth. Nodus flips that:

- **Local-network-first.** Your devices talk directly to your Storage Node
  over Wi-Fi or wired LAN, as long as they're on the same network. No
  Internet required for day-to-day sync.
- **Internet as enhancement, not dependency.** A Relay server provides
  signaling, cross-network sync, and temporary buffering when devices aren't
  on the same network — but it never holds plaintext file contents or keys.
- **Recoverable by design.** If the Relay's database is lost, it can be
  fully rebuilt from snapshots held by your Storage Node(s).
- **Convergent, not "last write wins."** Independently made offline changes
  reconcile without an arbitrary winner overwriting the other.

## How it works

Four components, one protocol:

| Component | Directory | Stack | Status |
|---|---|---|---|
| **Web client** | `apps/web` | Next.js + `packages/ui` (Tailwind v4) | UI ported; session auth wired; live sync TBD |
| **Mobile client** | `apps/mobile` | React Native / Expo | Scaffold only |
| **Storage Node** | `services/storage-node` | Rust, SQLite | Sync + object store implemented |
| **Relay** | `services/relay` | Go, PostgreSQL, Redis | Control plane + buffer implemented |

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
                        Wi-Fi / LAN
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
│  ├─ web/                 # Next.js web client (ported design UI)
│  └─ mobile/               # React Native / Expo mobile client (scaffold)
├─ packages/
│  ├─ core/                 # Domain logic: sharding, crypto abstractions
│  ├─ protocol/              # Canonical protocol schemas/types (zod, JSON Schema)
│  ├─ relay-client/          # WebSocket client (web + mobile)
│  ├─ webrtc-transport/      # WebRTC abstraction
│  ├─ transfer-manager/      # Cross-path transfer orchestration + repair
│  ├─ ui/                    # Shared design system (Tailwind v4, ported prototype)
│  └─ config/                # Shared TypeScript tooling (eslint/ts configs)
├─ services/
│  ├─ relay/                 # Go Relay (control plane + buffer)
│  └─ storage-node/           # Rust Storage Node (data plane)
├─ docs/
│  ├─ architecture/
│  ├─ protocol/
│  ├─ security/
│  ├─ decisions/             # ADRs (key hierarchy, recovery, GC, ...)
│  └─ design-port-plan.md    # Prototype → implementation mapping
├─ pnpm-workspace.yaml
└─ turbo.json
```

The TypeScript apps and packages are managed by Turborepo + pnpm. The Rust
Storage Node and Go Relay live in the same repository under `services/` but
sit outside the pnpm/Turborepo workspace, with their own native tooling.

## Current status

Implemented and tested (see `CHANGELOG.md` for detail):

- **Design foundations** — five ADRs locked in `docs/decisions/`: key
  hierarchy, recovery mechanism, conflict-resolution UX, mobile local
  discovery, and GC policy.
- **Protocol** (`packages/protocol`) — canonical wire schemas with runtime
  (zod) validation and generated JSON Schema, versioned and documented.
- **Storage Node** (`services/storage-node`, Rust) — SQLite schema, run-time
  configurable data directory, content-addressed object store with atomic
  writes, crash recovery, reconciliation, and automatic GC per ADR-0005.
- **Relay** (`services/relay`, Go) — REST API (Argon2id password auth, opaque
  server-side sessions via HttpOnly cookie), WebSocket hub with presence, and a
  transient encrypted shard buffer with TTL sweep.
- **Transfer sync** (`services/relay` ↔ `services/storage-node`) — incremental
  sync, full snapshot / relay rebuild (`Path C`), buffer-and-relay transfers,
  and the repair (data-return) path.
- **Transfer Manager** (`packages/transfer-manager`) — path selection,
  fan-out, and repair orchestration for the four transfer paths.
- **Web client** (`apps/web`) — the Figma prototype (`nodus-design/`) ported
  to a Tailwind v4 shared design system (`packages/ui`); six dashboard routes
  plus a real auth wizard (Phase 7a §3), accessible (axe-clean) in light and
  dark themes. `/auth` signs in / creates accounts through `app/api/auth/*`
  route handlers that proxy the Relay and set the HttpOnly session cookie;
  `/` and the dashboard group require a valid session. `/pair` (Phase 7a §4)
  is server-guarded and pairs Storage Nodes through session-authenticated
  proxies (`/api/nodes`, `/api/pairing/*`) — no client-side Bearer/JWT.

Full build order and the phase-by-phase checklist:

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

## Getting started

### Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Node.js + pnpm | Node ≥ 20, pnpm 11 | Web client, TypeScript packages |
| Rust | stable toolchain + `cargo` | Storage Node |
| Go | ≥ 1.22 | Relay |
| Docker | Compose v2 | Postgres + Redis for the Relay |

### 1. Install dependencies & hooks

```bash
make install-hooks      # gofmt/rustfmt/clippy pre-push hooks
pnpm install            # TypeScript workspace (apps + packages)
```

### 2. Run the web client

```bash
cd apps/web
pnpm dev                # http://localhost:3000
```

The dashboard, overview, and settings routes render with mock data; `/auth`
is the real session-cookie wizard. `pnpm build && pnpm start` for a
production-style build. To run the web client against the Relay locally, start
the Relay with `SESSION_COOKIE_SECURE=false` (plain HTTP) and point the web
app at it via `RELAY_URL` (defaults to `http://localhost:8080`).

### 3. Run the Relay (Go)

```bash
cd services/relay
docker compose up -d    # Postgres 17 + Redis 7 (health-checked)
go run .
```

The relay listens on `:8080` by default. Configuration via env vars:

| Env | Default |
|---|---|
| `PORT` | `8080` |
| `DATABASE_URL` | `postgres://nodus:nodus_password@localhost:5432/nodus_relay?sslmode=disable` |
| `REDIS_URL` | `redis://localhost:6379/0` |

Migrations run automatically on startup.

### 4. Run the Storage Node (Rust)

```bash
cd services/storage-node
cargo run -- --data-dir ~/NodusBackup       # or export NODUS_DATA_DIR=~/NodusBackup
```

First run creates the data directory, initializes the SQLite database, and
generates the node identity. Without `--data-dir` it prompts interactively
(and picks `~/NodusBackup` by default).

### Tests

```bash
pnpm test                                # all JS/TS, Relay (Go), and Storage Node (Rust) tests
```

This requires Node/pnpm, Go, and Cargo. Relay tests that require external
services are skipped by default. To include them, start the Relay Compose
dependencies and provide `TEST_DATABASE_URL` (and `TEST_REDIS_URL` where
needed):

```bash
docker compose -f services/relay/docker-compose.yml up -d
TEST_DATABASE_URL='postgres://nodus:nodus_password@localhost:5432/nodus_relay?sslmode=disable' \
  TEST_REDIS_URL='redis://localhost:6379/0' \
  pnpm test
```

## License

MIT
