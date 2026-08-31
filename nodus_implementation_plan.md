# Nodus — Hybrid Offline-First P2P Storage System — Implementation Plan

## 0. Foundational Design Decisions (Resolve Before Step 1)

Five decisions currently listed as "remaining design decisions" in §29 are load-bearing —
storage schema, sync protocol, and client behavior all assume answers to these exist.
Resolve them first, on paper, before writing the Rust SQLite schema or the protocol
package. Revisiting them mid-build is far more expensive than revisiting them now.

1. **Key hierarchy and recovery-key mechanism** (detailed in §9, §25, §29). Device
   revocation, node trust, snapshot signing, and key envelopes all depend on this.
2. **Conflict-resolution UX** (expanded in §17a below). "Let the user resolve it" needs
   a concrete mechanism before the file state machine (§23) can be finalized.
3. **Mobile local-discovery approach** (expanded in §7a below). Whether Path A (Direct
   Local P2P) is reliable on mobile at all depends on this.
4. **Reconciliation repair action** (expanded in §21a below). Detecting divergence is
   only half the job.
5. **Garbage-collection policy** (expanded in §29a below). Immutable versions +
   tombstones + content-addressed objects accumulate storage indefinitely without one.

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

Use QR-based pairing where possible.

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

```text
~/.nodus/
|
+-- node.db
+-- identity/
+-- objects/
|   +-- ab/
|   +-- cd/
|   +-- ...
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

files
file_versions
file_locations

key_envelopes

sync_events
sync_cursors

tombstones
```

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

---

## 29. Remaining Design Decisions

Before implementation, finalize these:

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
- Pairing/QR format
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
