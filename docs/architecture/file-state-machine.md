# File State Machine (Relay `file_locations.status`)

The Relay's `file_locations` table is the single source of truth for the
lifecycle of each `(file_id, version_number, shard_index, node_id)` shard.
Every shard transitions through the fixed sequence below; the states are the
only legal values of the `status` column.

## States

```
CREATED ──► UPLOADING ──► RELAY_BUFFERED ──► NODE_RECEIVING ──► NODE_VERIFIED ──► NODE_STORED ──► RELAY_CLEANUP
```

| State | Meaning | Owner of the bytes | Terminal? |
|---|---|---|---|
| `CREATED` | Shard slot reserved (schema default); unused by the HTTP upload path | — | no |
| `UPLOADING` | Client is mid-`POST /buffer/upload`; transient reservation before commit | client | no |
| `RELAY_BUFFERED` | Bytes committed to the Relay buffer (`buffer_id` set); awaiting node pickup | Relay | no |
| `NODE_RECEIVING` | Node consumed the single-use fetch token; bytes in flight to the node | node (transfer) | no |
| `NODE_VERIFIED` | Node acked `verified`; Relay copy still on disk until cleanup | node | no |
| `NODE_STORED` | Node owns the shard; Relay `buffer_id` cleared and file deleted | node | yes |
| `RELAY_CLEANUP` | Shard abandoned (TTL expiry, crashed upload, failed pickup) | — | yes |

The transitions that Shift-state by acks/sweeps:

- `RELAY_BUFFERED → NODE_RECEIVING`: node calls `GET /buffer/fetch` with a valid
  single-use token (`handler/buffer_fetch.go`, guarded by a status check so a
  second fetch is `409`).
- `NODE_RECEIVING → NODE_VERIFIED → NODE_STORED`: node ack `shard_ack
  status="verified"` (`handler/ws.go` `handleShardAckVerified`).
- `NODE_RECEIVING → RELAY_BUFFERED`: node ack `status="failed"`; the buffer file
  is kept for redelivery (`handleShardAckFailed`).
- `UPLOADING → RELAY_CLEANUP`: TTL sweep, crashed client (>1 h grace, see
  `buffer/buffer.go` `sweepOrphanedUploading`).
- `RELAY_BUFFERED → RELAY_CLEANUP`: TTL sweep runs down the buffer's lease
  (default 72 h, `cfg.BufferTTL`).
- `NODE_RECEIVING` / `NODE_VERIFIED → RELAY_BUFFERED`: recovery sweep reverts
  shards whose node vanished mid-transfer (>30 min grace, `sweepStuckInTransit`).

## Recovery / redelivery

- On (re)connect and `register`, the Relay scans all `RELAY_BUFFERED` shards for
  the node and re-notifies via `pending_notify` with a fresh fetch token
  (`handler/ws.go` `checkAndDeliverPendingShards`). Tokens are re-issued on
  every reconnect because a token minted while the node was offline may expire.
- A node crash between fetch and ack is self-healing: the recovery sweep returns
  the shard to `RELAY_BUFFERED` and the next reconnect delivers it again.

## Invariants

1. Terminal states (`NODE_STORED`, `RELAY_CLEANUP`) are never left.
2. A `buffer_id` is set exactly while the Relay owns the bytes
   (`RELAY_BUFFERED`, in-transit states) and cleared the moment custody passes to
   the node (`NODE_STORED`) or the file is reclaimed (`RELAY_CLEANUP`).
3. Duplicate/stale acks are rejected: `verified`/`failed` only apply from
   `NODE_RECEIVING`, and the fetch endpoint refuses a second token for the same
   row.