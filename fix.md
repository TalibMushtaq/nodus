# Storage Node Audit — Fix Plan

Status: Phases 1-15 implemented and committed (one commit per phase). All audit
findings are addressed, and the ADR-0003 conflict flow is now complete
end-to-end (node persistence in Phase 12, web inbox + in-place resolution in
Phases 13/15). Only optional/design-level follow-ups remain (see Deferred).

Source audit: `services/storage-node/` (Rust, ~13.7k LOC). Baseline at plan time:
`cargo fmt --check` clean, `cargo clippy --all-targets` clean, `cargo test` 168 passed.

Every code change follows `documentation-standards`: inline comments explaining
*why* on non-trivial edits, plus a `CHANGELOG.md` entry (newest at top, prescribed
format). Each phase is committed separately.

## Decisions (recorded)

- **Scope:** execute all phases in order.
- **#4 (signaling signature binds SDP/ICE):** Phase 7 — sign
  `"{device}:{session}:{timestamp}:{blake3(payload)}"`. HTTP-only (not a wire
  schema), so no relay protocol bump; mixed-version Path A fails 401 and falls
  back to Path B/C, so the change is safe to roll out in one deploy.
- **#11 (malformed known-type events):** return `Err` so the batch retries, with a
  bounded retry/skip so one poison event cannot block sync forever; unknown types
  stay acked for forward-compat.
- **#13 (`transfer/webrtc_client.rs`):** broken and unreachable — delete it.
- **#22 (relay buffer shard hash):** the node has no authoritative per-shard hash
  to check against (the version event carries only the whole-version hash), so a
  compromised relay can plant bytes for the *first* copy. Phase 8 adds a
  consistency guard (never overwrite a known shard with a different object) and
  documents the required protocol addition (`shard_hashes` on
  `FILE_VERSION_ADDED`); full closure is a cross-language protocol change.

---

## Phase 1 — Data integrity & durability (commit: `fix(storage-node): phase 1 ...`)

### 1.1 #3 `change_data_dir` crash-safe migration (`config/mod.rs`, `menu.rs`)
- Write+fsync a migration journal `{old, new, state}` before any move.
- Primary: atomic whole-directory `fs::rename(old, new)` on same FS (target empty).
- Fallback on `EXDEV`: per-entry copy, moving `nodus.db` **last**, fsync parent.
- On startup: if journal exists and state is mid-move, complete/repoint or refuse
  to boot — never `create_if_missing` an empty DB silently.
- Tests: partial move, journal recovery both directions, EXDEV fallback.

### 1.2 #6 fsync after rename / atomic `restore_object` (`store/write.rs`, `store/reconcile.rs`)
- `fsync_dir(parent)` helper after `rename` in `put` and `recover_temp_writes`.
- `restore_object` reuses temp-write + `sync_all` + rename + dir-fsync; metadata
  `UPDATE` asserts one row (or inserts).

### 1.3 #5 handle `TOMBSTONE_REMOVED` (`sync/engine.rs`)
- Add arm to `apply_remote_event_conn` deleting `tombstones` for
  `(entity_type, entity_id)`; default `entity_type=file` to match the relay.
- Test: restore removes tombstone; GC no longer purges the file.

### 1.4 #1 WSS-only daemon link (`main.rs`, `sync/client.rs`, `pair.rs`)
- Extract loopback-aware `ensure_secure_transport` into a shared helper; reject
  non-loopback `ws://`/`http://` in `resolve_daemon_relay`.
- Tests: reject public `ws://`, allow `ws://127.0.0.1`.

## Phase 2 — Resource bounds & concurrency (commit: `fix(storage-node): phase 2 ...`)

### 2.1 #2 bounded response bodies (`sync/client.rs`, `transfer/node_attempter.rs`, `Cargo.toml`)
- Shared `MAX_SHARD_BYTES`; add reqwest `stream`; capped `bytes_stream()`
  accumulator + early `Content-Length` reject; validate `n.size` before read.

### 2.2 #7 serialize GC vs write/reconcile (`store/mod.rs`, `gc.rs`, `reconcile.rs`, `write.rs`)
- Shared `RwLock<()>`: ingest/put/restore read; GC/reconcile write on delete/refcount.
- Refcount check + delete in one transaction; re-check `dest.exists()` before upsert.

### 2.3 #8 bound WebRTC sessions/channels (`webrtc/session.rs`, `handler.rs`, `local/server.rs`)
- Caps: global, per-device, channels/connection, absolute session lifetime.
- Rate-limit `/nodus/webrtc/offer`.

### 2.4 #9 eliminate byte-slice panics (`sync/conflict.rs`, `store/layout.rs`, `report.rs`, `local/mdns.rs`)
- `chars().take(n)` / boundary-safe; `layout::object_path` returns `Result` and
  validates exactly 64 lowercase hex.

## Phase 3 — Trust boundary & sync correctness (commit: `fix(storage-node): phase 3 ...`)

### 3.1 #10 verify tombstone before `purge_tombstone` (`sync/client.rs`)
### 3.2 #12 anti-resurrection guards in projections (`sync/engine.rs`)
### 3.3 #14 strict `shard_done` JSON parse (`webrtc/session.rs`)
### 3.4 #15 atomic shard receive + pending fallback (`webrtc/session.rs`)
### 3.5 #20 `checked_add` version renumber; reject `version_number < 1`
### 3.6 #23 `fetch_token` via header/encoded; scrub URLs from logged errors
### 3.7 #11 malformed-event policy: `Err` + bounded skip (see Decisions)

## Phase 4 — Persistence, indexes, policy (commit: `fix(storage-node): phase 4 ...`)

### 4.1 #16 atomic config writes (`config/mod.rs`)
### 4.2 #17 identity hardening: 0600 check, atomic key write, zeroize read buffer
### 4.3 #18 indexes/constraints migration (shards.object_id, storage_objects.status,
   tombstones.deleted_at, files.parent_folder_id, files.updated_at, unique sync_outbox)
### 4.4 #19 re-verify existing object on `put` (stream hash; overwrite on mismatch)
### 4.5 #25 GC policy gaps: recursive `purge_folder`; clear `pending_shard_fetches`;
   skip live-tombstone files
### 4.6 #24 atomic snapshot counter (`UPDATE ... RETURNING`)
### 4.7 #21 bounded reconciliation: page rows, budget, anti-join

## Phase 5 — Cleanup & low-risk (commit: `fix(storage-node): phase 5 ...`)

- #13 delete `transfer/webrtc_client.rs` (and module wiring).
- `backoff.rs` `checked_mul`; `telemetry.rs` poison-tolerant locks; log GC unlink
  failures; `client.rs` capability string; configurable STUN; one malformed frame
  must not kill the session; `sync_status` implement or remove.

## Phase 6 — Residual races & sync robustness (commit: `fix(storage-node): phase 6 ...`)

### 6.1 #7 GC refcount+delete atomic (`store/gc.rs`)
- Replace `SELECT COUNT(*)` then `DELETE storage_objects` with one conditional
  `DELETE ... WHERE object_id = ? AND NOT EXISTS (SELECT 1 FROM shards ...)`;
  remove the file only when exactly one row was deleted.

### 6.2 #M2 `store_pairing_token` enforces the push's target node (`sync/client.rs`)
- Ignore pushes whose `node_id` is not this node, matching the doc comment and
  the local-redemption re-check.

### 6.3 #M10 envelope `schema_version` compatibility (`sync/client.rs`)
- Reject an inbound envelope whose major version is not 1 (log + skip the frame),
  rather than silently parsing a forward-incompatible surface.

### 6.4 #L3 outbox timestamp ordering (`sync/outbox.rs`)
- Compare timestamps with SQLite `datetime(...)` so mixed `Z`/`+00:00`/fractional
  RFC3339 forms order correctly.

## Phase 7 — #4 signaling signature binds SDP/ICE (commit: `fix(storage-node): phase 7 ...`)

- Rust `webrtc/handler.rs`: sign/verify `"{device}:{session}:{timestamp}:{blake3(payload)}"`
  for the offer (`sdp`) and ICE candidate endpoints; the SSE receive stream keeps
  the payload-free message.
- TS `packages/webrtc-transport/src/signaling.ts`: compute the same BLAKE3 hash
  (already depends on `@noble/hashes`) for offer/answer/candidate; SSE unchanged.
- Update `tests/webrtc_transfer_test.rs` and the signing doc comment; verify
  `pnpm test` for the TS package.

## Phase 8 — #22 relay-buffer integrity (commit: `fix(storage-node): phase 8 ...`)

- Never overwrite a known `(file_id, version_number, shard_index)` shard with a
  different object id from a relay `pending_notify`; log and reject on conflict.
- Document in `fix.md` and the changelog that full verification requires a signed
  per-shard manifest (`shard_hashes`) on `FILE_VERSION_ADDED` — a cross-language
  protocol change, not implementable node-side alone.

## Phase 9 — Remaining contained audit items (commit: `fix(storage-node): phase 9 ...`)

### 9.1 Engine idempotency TOCTOU (`sync/engine.rs`)
- Check `rows_affected()` of the `sync_events` insert; a concurrent double-apply
  that hits `ON CONFLICT DO NOTHING` must return `AlreadyApplied` and skip
  projections (the deferred SELECT is not enough under two connections).

### 9.2 WeRTC manager: don't hold the map lock across session creation (`webrtc/session.rs`)
- Serialize creation per session id with a per-id mutex, create the peer
  connection outside the global `RwLock`, then insert; the single-flight test
  must still observe one shared `Arc`.

### 9.3 WeRTC channel: don't hold the receive mutex across I/O (`webrtc/session.rs`)
- Take the lock only to validate/consume state, then verify/persist/ack outside
  it so a slow disk cannot block the channel or the stall watcher.

### 9.4 Snapshot: log omitted versions (`sync/snapshot.rs`)
- A `file_version` with an empty hash / non-positive shard count is omitted from
  a rebuild; log it rather than dropping it silently.

## Phase 10 — #22 device-signed per-shard manifest (commit: `fix(storage-node): phase 10 ...`)

### 10.1 Protocol (`packages/protocol`)
- New `FILE_SHARD_MANIFEST` event: `{ file_id, version_number, shard_hashes, signature }`.
- Signature message `"nodus-shard-manifest:v1:{file_id}:{version}:{blake3(hashes.join(','))}"`,
  signed by the uploading device's Ed25519 key; schemas regenerated.

### 10.2 Relay (`services/relay/internal/handler/sync.go`)
- Add the type to `deviceAllowedEventType`; the event is logged/forwarded like
  any other (no projection needed — nodes are the verifiers).

### 10.3 Storage node
- Migration `file_version_shard_hashes`.
- `sync/engine.rs` verifies the origin device's signature and stores the hashes,
  then re-checks already-stored shards (marking mismatches DEGRADED).
- `sync/client.rs` (Relay buffer) and `webrtc/session.rs` (Path A) refuse a shard
  whose object id differs from the signed manifest.

### 10.4 Web uploader (`apps/web/lib`)
- Persist each uploaded shard hash in progress; after all shards, emit the
  signed `FILE_SHARD_MANIFEST` (retried on resume). `signManifest` is optional so
  non-browser harnesses remain compatible.

## Phase 11 — M8 snapshot send (commit: `fix(storage-node): phase 11 ...`)

### 11.1 Heartbeat during snapshot transmission (`sync/client.rs`)
- `stream_snapshot` sends a liveness heartbeat on the 30 s cadence between
  chunks, so a long rebuild cannot make the Relay mark the node offline. Shared
  `send_heartbeat` helper with the idle select loop.

### 11.2 Single-pass chunk building (`sync/snapshot.rs`)
- Build homogeneous chunks directly from the SQL row streams (via
  `push_snapshot_record`) instead of loading every table into per-type `Vec`s
  first, halving peak metadata memory. Chunk order, 1000-record cap, and skip
  rules are unchanged, so the content hash is byte-identical.

## Phase 12 — M6 node-side conflict persistence (commit: `fix(storage-node): phase 12 ...`)

### 12.1 Persist the ADR-0003 sibling name (`sync/engine.rs`, migration)
- Migration `20260914000003_file_version_conflicted_name.sql` adds
  `file_versions.conflicted_name`; the fork path writes the computed
  `generate_conflicted_filename` value instead of discarding it.

### 12.2 Carry it in snapshots and surface it locally (`sync/snapshot.rs`, `report.rs`, `shell.rs`)
- `FileVersionRecord` / protocol snapshot schema gain an optional
  `conflicted_name`; `report::conflicts` + a `conflicts` shell command list the
  preserved siblings so the node's local status shows them.

## Phase 13 — ADR-0003 web conflict inbox (commit: `fix(web): phase 13 ...`)

### 13.1 Derive conflicts from the existing catalog (`lib/catalog.ts`, `lib/conflicts.ts`)
- The Relay `GET /files` already returns per-version `conflict_status`, so
  `CatalogEntry` now records every `flagged` version (`conflicted_versions`), and
  `listConflicts` decrypts names the same way the Files page does.

### 13.2 Persistent inbox (`lib/use-conflicts.ts`, `app/(dashboard)/conflicts/*`, `components/sidebar.tsx`)
- A `useConflicts` hook (mount + refresh + 15 s poll) and a `/conflicts` page
  listing preserved conflicted copies with a link to resolve them in Files; the
  sidebar gains a Conflicts entry.

## Phase 14 — Remaining audit lows (commit: `fix(storage-node): phase 14 ...`)

### 14.1 Durability pragma (`db.rs`)
- Set `PRAGMA synchronous = FULL` (WAL defaults to NORMAL) so a power loss
  cannot drop the last committed metadata transaction for a backup product.

### 14.2 Auth ordering + sync_status (`sync/client.rs`)
- Only honour a `node_auth_result{ok}` after a challenge was answered; use
  `sync_status` to warn when the Relay's per-origin cursor is behind the local
  one (possible relay data loss) instead of discarding it.

### 14.3 Authenticate before id validation (`local/server.rs`)
- `/nodus/shard/{id}` verifies the signed caller before rejecting a malformed id,
  removing the unauthenticated 400-vs-401 oracle.

### 14.4 Clock-safe session reaping (`webrtc/session.rs`)
- `should_prune` treats `now == 0` (pre-epoch/unavailable clock) as unknown and
  keeps sessions rather than reaping them all.

## Phase 15 — In-place conflict resolution (commit: `fix(web): phase 15 ...`)

### 15.1 Protocol (`packages/protocol`)
- New `CONFLICT_RESOLVED { file_id }` event (schemas regenerated).

### 15.2 Relay + node
- Relay `applySingleEventTx` and the node's `apply_remote_event_conn` both set
  `file_versions.conflict_status = 'resolved'` for the file's `flagged` versions
  (version data retained); the node's `report::conflicts` now filters on
  `conflict_status = 'flagged'`.

### 15.3 Web
- `conflictResolvedEvent` builder; the Conflicts inbox gains a **Resolve** button
  that emits the event (serialized via the existing event-batch hook) and
  revalidates. Mobile remains a scaffold.

## Verification (each phase)

- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.
- SQLite changes: fresh-DB + upgrade-in-place migration tests.
- Protocol changes: `pnpm test` + schema regen.
- E2E: `scripts/e2e-path-c.sh`, `tests/offline_divergence_test.rs`.
- `CHANGELOG.md` entry per phase.

## Deferred / needs investigation

- **ADR-0003 mobile conflict inbox** — the web inbox and in-place resolution
  ship (Phases 13/15); the mobile app is still a scaffold and would render from
  the same `CatalogEntry` data model.
- **M8 true streaming** — chunks are still all held before BEGIN (which carries
  the final content hash), so a rebuild still holds O(chunks) metadata; Phase 11
  removed the O(records) intermediate buffers and fixed the liveness block. A
  genuine O(chunk) stream would need a two-pass scan or a protocol change to
  BEGIN/chunk ordering.
- **Relay-rebuild caveat for #22 and conflicted_name** — `file_version_shard_hashes`
  and `conflicted_name` are node-local and not persisted by the relay's snapshot
  ingestion, so a relay rebuilt from scratch won't re-serve them. Existing nodes
  keep their copies; carrying these in relay snapshots is a possible follow-up.
