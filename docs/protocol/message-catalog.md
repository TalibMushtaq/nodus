# Message Catalog

This is the human-readable reference for every Nodus wire message. The
`packages/protocol` zod schemas are the source of truth; this document is a
language-neutral counterpart maintained alongside `src/`. Machine-readable JSON
Schema equivalents are generated from the zod schemas via `pnpm generate:schemas`
(see `schemas/`).

All messages share a common envelope before their type-specific payload:

```json
{
  "type": "shard_upload",
  "schema_version": "1.0",
  "message_id": "uuid",
  "payload": { "...": "..." }
}
```

Field naming is `snake_case` on the wire throughout. TS consumers map to/from
`camelCase` at the serialize/deserialize boundary.

---

## Control Messages

### `register`

Device/node identity announcement to the Relay, sent once when a device or node
first connects. Used to establish presence and authorization.

| Field | Type | Required | Notes |
|---|---|---|---|
| `account_id` | string | yes | The owning account |
| `device_id` | string | no | Set when a device registers |
| `node_id` | string | no | Set when a storage node registers |
| `public_key` | string | yes | X25519 public key, hex-encoded |
| `capabilities` | array&lt;enum&gt; | no (default `[]`) | Values: `storage`, `signaling`, `sync` |

### `heartbeat`

Liveness ping. Minimal payload; drives Relay-side presence (§13 Redis presence).
A node/device is marked absent if no heartbeat arrives within the configured
window.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | The node or device sending the heartbeat |
| `timestamp` | ISO 8601 string | yes | When the heartbeat was sent |

---

## WebRTC Signaling Messages

These carry SDP/ICE payloads **verbatim** as opaque strings. The protocol layer
does not validate SDP or candidate internals. `from_peer`/`to_peer` let the Relay
route Path B signaling without inspecting payload contents (§5).

`from_peer` and `to_peer` are each either a `device_id` or a `node_id`.

### `webrtc_offer`

| Field | Type | Required | Notes |
|---|---|---|---|
| `from_peer` | string | yes | Origin peer |
| `to_peer` | string | yes | Destination peer |
| `sdp` | string | yes | SDP offer body (opaque) |

### `webrtc_answer`

| Field | Type | Required | Notes |
|---|---|---|---|
| `from_peer` | string | yes | Origin peer |
| `to_peer` | string | yes | Destination peer |
| `sdp` | string | yes | SDP answer body (opaque) |

### `webrtc_ice_candidate`

| Field | Type | Required | Notes |
|---|---|---|---|
| `from_peer` | string | yes | Origin peer |
| `to_peer` | string | yes | Destination peer |
| `candidate` | string | yes | ICE candidate (opaque) |

---

## Transfer Messages

### `shard_upload`

Carries **metadata only** — the actual encrypted shard bytes travel over HTTP
(`POST /buffer/upload`) or a separate binary transport, referenced by
`transfer_id`. This avoids base64-encoding up to 8 MB per shard in JSON
(decision #2).

| Field | Type | Required | Notes |
|---|---|---|---|
| `file_id` | string | yes | Logical file identifier |
| `version_number` | integer ≥ 1 | yes | File version this shard belongs to |
| `shard_index` | integer ≥ 0 | yes | 0-based shard position in the file |
| `hash` | string | yes | BLAKE3 hex digest of the encrypted ciphertext |
| `size` | integer ≥ 0 | yes | Encrypted payload size in bytes (wire size) |
| `transfer_id` | string | yes | Ties this metadata to the binary transfer stream |
| `target_node` | string | no | Node that should receive the shard |
| `source_device` | string | no | Device that initiated the upload |

### `shard_ack`

Acknowledges receipt/verification of a shard. Ties into the file state machine
(§23: `NODE_RECEIVING` → `NODE_VERIFIED`).

| Field | Type | Required | Notes |
|---|---|---|---|
| `file_id` | string | yes | Logical file identifier |
| `version_number` | integer ≥ 1 | yes | File version this shard belongs to |
| `shard_index` | integer ≥ 0 | yes | 0-based shard position |
| `status` | enum | yes | `received`, `verified`, or `failed` |
| `transfer_id` | string | yes | Correlates to the original `shard_upload` |
| `error_message` | string | no | Human-readable reason when `status` is `failed` |

### `pending_notify`

Relay → Node notification that a buffered shard is waiting for pickup
(Path C, §13 relay buffer lifecycle). Sent when a client uploaded a shard
via `POST /buffer/upload` while the target node was offline. Includes a
`fetch_token` so the node can fetch the shard bytes over HTTP.

| Field | Type | Required | Notes |
|---|---|---|---|
| `file_id` | string | yes | Logical file identifier |
| `version_number` | integer ≥ 1 | yes | File version this shard belongs to |
| `shard_index` | integer ≥ 0 | yes | 0-based shard position |
| `buffer_id` | string | yes | Relay-assigned buffer identifier |
| `fetch_token` | string | yes | Single-use token for `GET /buffer/fetch` (10-min TTL, Redis GETDEL) |
| `from_device` | string | yes | Device that uploaded the shard |
| `hash` | string | yes | BLAKE3 hex digest — node verifies after fetch |
| `size` | integer ≥ 0 | yes | Encrypted payload size in bytes — node verifies after fetch |

### `shard_fetch`

Request to retrieve a shard from a peer or the Relay buffer.

| Field | Type | Required | Notes |
|---|---|---|---|
| `file_id` | string | yes | Logical file identifier |
| `shard_index` | integer ≥ 0 | yes | 0-based shard position |
| `transfer_id` | string | yes | Correlates the fetch to the binary delivery |
| `source` | string | yes | `relay_buffer`, or a `node_id` |

### `shard_delete`

Request to delete a shard (e.g. post-transfer cleanup, or GC per §29a).

| Field | Type | Required | Notes |
|---|---|---|---|
| `file_id` | string | yes | Logical file identifier |
| `shard_index` | integer ≥ 0 | yes | 0-based shard position |
| `reason` | string | no | Informational only; not parsed |

---

## Sync Messages

### `sync_hello`

Initial cursor-exchange handshake (§18). Sent when a node (or client) comes online
to initiate incremental sync.

| Field | Type | Required | Notes |
|---|---|---|---|
| `node_id` | string | yes | The sending node |
| `cursors` | array of cursors | yes | Per-origin `{ origin_id, sequence }` |

### `sync_status`

Response to `sync_hello`. Each cursor adds a count so the sender can gauge how far
behind it is.

| Field | Type | Required | Notes |
|---|---|---|---|
| `node_id` | string | yes | The responding node |
| `cursors` | array of cursors | yes | Per-origin `{ origin_id, sequence, known_count }` |

### `event_batch`

Wraps one or more sync events (§15). See `event-types.md` for the complete event
schema and payload shapes. This is where the "exact sync event schema" open item
is finalized.

| Field | Type | Required | Notes |
|---|---|---|---|
| `events` | array of events | yes | Events ordered by `origin_sequence` within each origin |

### `reconcile`

Physical reconciliation signal (§21). Carries a content hash / manifest reference
rather than full file lists — the receiver compares hashes and requests a full
snapshot only on divergence.

| Field | Type | Required | Notes |
|---|---|---|---|
| `node_id` | string | yes | The reconciliation source |
| `content_hash` | string | yes | BLAKE3 of the node's file manifest |
| `checkpoint` | integer ≥ 0 | yes | Sequence checkpoint of this reconciliation |

---

## Snapshot Messages

### `snapshot_begin`

Metadata for a full snapshot transfer (§20). The Relay validates the signature
against the trusted node public key before accepting chunks.

| Field | Type | Required | Notes |
|---|---|---|---|
| `snapshot_id` | string | yes | Snapshot identifier |
| `node_id` | string | yes | Source node |
| `sequence` | integer ≥ 0 | yes | Sequence/checkpoint this snapshot represents |
| `total_chunks` | integer ≥ 1 | yes | Number of chunks before `snapshot_end` |
| `content_hash` | string | yes | BLAKE3 of the full snapshot payload |
| `signature` | string | yes | Ed25519 over `content_hash` |
| `data_schema_version` | string | yes | Version of the data *inside* the snapshot |

### `snapshot_chunk`

Ordered chunk of snapshot data. Reassembled by `chunk_index`; retries reuse the
same index for idempotency.

| Field | Type | Required | Notes |
|---|---|---|---|
| `snapshot_id` | string | yes | Snapshot identifier |
| `chunk_index` | integer ≥ 0 | yes | 0-based reassembly order |
| `data` | string | yes | Chunk payload (base64 or binary depending on transport) |

### `snapshot_end`

Completion marker. The Relay validates `final_hash` against the hash promised in
`snapshot_begin` before promoting the rebuilt state.

| Field | Type | Required | Notes |
|---|---|---|---|
| `snapshot_id` | string | yes | Snapshot identifier |
| `final_hash` | string | yes | BLAKE3 of all chunk data concatenated |
| `signature` | string | yes | Ed25519 over `final_hash` |

---

## Error Message

A generic error/rejection envelope (decision #5). When a receiver cannot process a
message, it responds with this instead of forcing every ack type to double as an
error carrier.

| Field | Type | Required | Notes |
|---|---|---|---|
| `correlation_id` | string | yes | The `message_id` of the message that caused the error |
| `error_code` | enum | yes | see error codes below |
| `error_message` | string | yes | Human-readable; not for programmatic routing |
| `retryable` | boolean | no | Whether the sender should retry |

### Error codes

`validation_error`, `unknown_message_type`, `incompatible_version`,
`auth_failure`, `not_found`, `rate_limited`, `internal_error`.
