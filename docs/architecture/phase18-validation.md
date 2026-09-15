# Phase 18 — Failure / Recovery / Stress Validation

Maps each Phase 18 scenario to the test or harness that exercises it. The Go
integration tests skip unless `TEST_DATABASE_URL` is set; the Rust and
TypeScript tests run in the normal suites.

| Scenario | Where it is exercised |
|---|---|
| Internet unavailable — client ↔ node keeps working | `services/storage-node/tests/webrtc_session_transfer_test.rs` (two peers negotiate and stream shards over WebRTC with no Relay); the LAN fetch path in `packages/relay-client` `NodeClient.fetchShard` and the device-auth endpoint in `services/storage-node/src/local/server.rs`. The Path A branch of `packages/sdk` `createAttemptPath` prefers this before any Relay path. |
| Relay PostgreSQL loss → full rebuild from node snapshots | `services/relay/internal/handler/rebuild_integration_test.go` and `snapshot_test.go` drive `SNAPSHOT_BEGIN/CHUNK/END` into a scratch database and verify promotion; the F2c envelope/folder staging assertions confirm the rebuild is lossless. |
| Node offline for an extended period → reconnect → convergence | `services/storage-node/tests/offline_divergence_test.rs` (two independent additions converge with no winner) and `services/relay/internal/handler/sync_integration_test.go` (`SYNC_HELLO`/`SYNC_STATUS` cursor exchange, `sequence_regression` recovery). |
| Concurrent conflicting edits → conflicted-copy UX | `services/relay/internal/handler/conflicts_integration_test.go` (flag + resolve, foreign-file rejection) with the ADR-0003 clients: `apps/web/lib/__tests__` conflict tests and the mobile conflict inbox (`apps/mobile/App.tsx`, REST resolve). |
| Disk corruption / missing objects → reconciliation repair (§21a) | Rust unit tests in `services/storage-node/src/store/reconcile.rs` (metadata→disk DEGRADED marking, disk→metadata orphan grace period) and `store/gc.rs` (retention/compaction); the node's node-to-node re-fetch attempter is covered by `src/transfer/node_attempter.rs` tests. |
| Load test — Relay buffer under sustained Path C usage | `services/relay/internal/handler/buffer_load_integration_test.go` (`TestBufferUploadSustainedLoad`): 50 concurrent shard uploads of one version all reach `RELAY_BUFFERED`. |
| Security review — Relay sees no plaintext; revocation removes access | `docs/security/phase18-review.md`, backed by `buffer_upload.go` (raw ciphertext), the opaque `key_envelopes`/`folder_key_envelopes` projections, and `device.go` revocation deleting both envelope rows. |

## Gaps

- The load test is a correctness smoke test, not a throughput benchmark; a
  numbers-producing buffer benchmark is still open.
- The "Internet unavailable" coverage is at the transport level; a full
  client-app-with-Router-down rehearsal (web/mobile UI) is not automated.
