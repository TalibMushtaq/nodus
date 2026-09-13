# Storage Node Audit — Fix Plan

Source audit: `services/storage-node/` (Rust, ~13.7k LOC). Baseline at plan time:
`cargo fmt --check` clean, `cargo clippy --all-targets` clean, `cargo test` 168 passed.

Every code change follows `documentation-standards`: inline comments explaining
*why* on non-trivial edits, plus a `CHANGELOG.md` entry (newest at top, prescribed
format). Each phase is committed separately.

## Decisions (recorded)

- **Scope:** execute all phases in order.
- **#4 (signaling signature binds SDP/ICE):** deferred — needs `CURRENT_SCHEMA_VERSION`
  1.5 → 1.6 and coordinated `packages/webrtc-transport` / `packages/relay-client`
  changes. Tracked below as a follow-up.
- **#11 (malformed known-type events):** return `Err` so the batch retries, with a
  bounded retry/skip so one poison event cannot block sync forever; unknown types
  stay acked for forward-compat.
- **#13 (`transfer/webrtc_client.rs`):** broken and unreachable — delete it.

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

## Verification (each phase)

- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.
- SQLite changes: fresh-DB + upgrade-in-place migration tests.
- Protocol changes: `pnpm test` + schema regen.
- E2E: `scripts/e2e-path-c.sh`, `tests/offline_divergence_test.rs`.
- `CHANGELOG.md` entry per phase.

## Deferred / needs investigation

- **#4** signaling signature must bind SDP/ICE (protocol 1.6 + TS clients).
- **#22** relay buffer metadata manifest cross-check — verify a node-side signed
  manifest of expected shard hashes exists before committing.
- **#11** bounded-skip semantics should be agreed with the relay's retry behavior.
