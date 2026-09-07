# Transfer Manager Specification

Shared contract for the TypeScript client-side (`packages/transfer-manager`) and
Rust node-side (`services/storage-node/src/transfer/`) implementations. Both
sides honor the same path enum, state machine, timeout table, and cache
semantics — the spec is the source of truth, not shared code.

## Transfer Paths

Four paths, tried in order. Paths A/B share a WebRTC DataChannel transport but
differ in how the signaling channel is established.

| Path | Enum | Signaling | Transport | Notes |
|------|------|-----------|-----------|-------|
| A | `LOCAL_SIGNALING` | Local HTTP (`/nodus/webrtc/*`) via fresh mDNS discovery | WebRTC DataChannel | LAN only; no Relay involvement |
| B | `RELAY_SIGNALING` | Relay WebSocket (`webrtc_offer`/`webrtc_answer`/`webrtc_ice_candidate`) | WebRTC DataChannel | Relay carries SDP/ICE only, never file data |
| C | `BUFFER_RELAY` | Relay HTTP (`POST /buffer/upload` → `GET /buffer/fetch`) | HTTP | Bytes temporarily stored in Relay buffer; relay is online mediator |
| D | `LOCAL_QUEUE` | — | In-memory or persistent queue | Fallback when Relay unavailable; retried on connectivity restoration |

## Per-Shard State Machine

```
PENDING ──► ATTEMPTING(path) ──► SUCCEEDED
                  │
                  ├─► (retry same path with backoff)
                  │
                  └─► FAILED_PERMANENT (all paths exhausted)
```

States:
- `PENDING` — shard transfer not yet started.
- `ATTEMPTING(path)` — actively trying a specific transfer path.
- `SUCCEEDED` — shard successfully transferred and verified.
- `FAILED_PERMANENT` — all paths exhausted; shard transfer will not succeed without operator intervention or new information.

## Fallback Sequence

```
1. Path A: Local signaling → fresh mDNS discovery → WebRTC negotiation → DataChannel transfer
   └─ failure →
2. Path B: Relay signaling → WS SDP exchange → WebRTC negotiation → DataChannel transfer
   └─ failure →
3. Path C: Buffer-and-Relay → POST /buffer/upload → relay stores → node fetches → relay deletes
   └─ relay unavailable →
4. Path D: Local persistent queue → store shard locally → retry on connectivity restoration
```

### Failure types per stage

Each stage in paths A/B has two distinct failure modes:

1. **Signaling failure** — couldn't establish the signaling channel at all
   (mDNS timeout, HTTP error, WS disconnect). Skip straight to next
   signaling method.

2. **WebRTC negotiation failure** — signaling succeeded (SDP offer/answer
   exchanged) but the DataChannel never opened within the timeout window.
   Also falls through; this is the case the ~4s benchmark targets.

### Path cache behavior

On cache hit for `node_id`:
1. Attempt the cached path first (using fresh mDNS if `LOCAL_SIGNALING` —
   never cache the IP, only the method).
2. On success → update cache with same path and fresh timestamp.
3. On failure → evict cache entry immediately, then fall through the
   remaining chain. Never retry a path that was just confirmed broken.

On cache miss:
- Start from path A and walk the full chain.

## Timeout Table

All values configurable via `TransferConfig`. Defaults below; tune after
benchmarking (see `scripts/benchmark-webrtc/`).

| Stage | Default Timeout | Notes |
|-------|----------------|-------|
| Local mDNS discovery | 2000 ms | Fresh discovery every attempt; IPs are DHCP-leased and unstable |
| WebRTC negotiation (Path A) | 4000 ms | From SDP offer to DataChannel open |
| Relay signaling round-trip | 3000 ms | WS message round-trip for SDP exchange |
| WebRTC negotiation (Path B) | 4000 ms | Same as Path A; negotiated over Relay signaling channel |
| Buffer-and-Relay upload | Unbounded | Governed by shard size (~8 MB) and network bandwidth |

## Backoff & Retry

Exponential backoff with jitter applied between retries of the *same*
stage before falling through to the next path.

Formula:

```
delay = base_ms * 2^attempt + random(0, jitter_ms)
```

> Jitter bound nuance: the TS side samples `[0, jitter)` (exclusive upper
> bound); the Rust side samples `[0, jitter]` (inclusive) because
> `rand::gen_range(0..0)` would panic when jitter is configured to 0. The
> ≤1ms difference is immaterial to the scheduling contract.

Default constants:
- `backoff_base_ms`: 500
- `backoff_jitter_ms`: 300
- `max_retries_per_stage`: 2

After 2 failed attempts at a stage, fall through to the next path without
further retries.

## Concurrency

Both implementations use a bounded concurrency pool for per-shard transfers.

- Default `max_concurrency`: 4
- Excess transfers queued FIFO and picked up as slots free
- Each queued transfer runs its own independent state machine (not a
  single global state machine processing one shard at a time)

## Path Cache Persistence

### Rust node-side

Columns on `trusted_nodes`:
- `last_successful_path TEXT` — enum value of the last successful path
- `last_success_at TEXT` — ISO 8601 timestamp of last successful transfer

Read/write in `transfer/cache.rs`. Updated on successful transfer; evicted
immediately on failure of a cached path.

### TypeScript client-side

In-memory `Map<string, { path, lastSuccessAt }>` with a generic
`PathCache` interface. Phase 14 will plug in IndexedDB/SQLite persistence.
The interface is:

```typescript
interface PathCache {
  get(nodeId: string): TransferPath | undefined;
  set(nodeId: string, path: TransferPath): void;
  evict(nodeId: string): void;
}
```

## Local Persistent Queue (Path D)

Generic interface with platform-specific backends:

```typescript
interface LocalQueue {
  enqueue(item: QueueItem): void;
  dequeue(): QueueItem | undefined;
  peek(): QueueItem | undefined;
  remove(transferId: string): void;
  onConnectivityRestored(callback: () => void): void;
}
```

Default implementation: `MemoryLocalQueue` (in-process, not persisted).
Phase 14 adds `IndexedDBLocalQueue` for web, `SQLiteLocalQueue` for mobile.

Retry scheduling is triggered on connectivity restoration or Relay
reachability — not a blind timer.

## Re-fetch-from-peer (§21 Repair)

When reconciliation marks an object `DEGRADED`, the repair path:

1. Query `trusted_nodes` for all peers.
2. Order: path-cache hits first, then by `last_success_at` descending.
3. Attempt `fetch_shard` from each peer using the full Transfer Manager
   fallback chain (fresh mDNS for Path A, then Path B, then Path C, then
   Path D).
4. On success: store object, mark `STORED`.
5. On permanent failure: leave `DEGRADED`; retry on next reconciliation
   scan.

v1 strategy: brute-force try all trusted nodes. No peer location index.
