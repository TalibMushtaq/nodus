# Nodus — Performance and Improvement Report

**Measured:** 2026-10-22  
**Scope:** client-side crypto/sharding pipeline, Relay Path C ingest, transfer timing contract, build/startup footprint, and full test-suite throughput.  
**Companion:** [`PROJECT_REPORT.md`](./PROJECT_REPORT.md) describes the architecture these measurements apply to.

> **Short version.** Nodus is fast at sharding and metadata handling, and the
> Relay can ingest full 8 MiB shards at ~0.86 GB/s in-process. The current
> client-side crypto pipeline is the main performance ceiling: AES-256-GCM +
> BLAKE3 through pure JavaScript sustains **~27 MiB/s upload** and **~55 MiB/s
> download** on this machine. Hardware-backed WebCrypto and worker parallelism
> are the highest-impact next improvements.

---

## 1. What Was Measured

| Area | Benchmark | What it exercises |
|---|---|---|
| Client sharding | `scripts/perf/crypto-bench.mjs` | `splitIntoShards`, `encryptShard`, `hashShard`, `decryptShard`, `reconstructFromShards` |
| Client key wrapping | same script | FEK envelope seal/open, filename encrypt/decrypt |
| Relay Path C ingest | Go `BenchmarkBufferUpload` | HTTP handler + BLAKE3 + SQLite writes + buffer write for a small shard |
| Relay full shard | Go `BenchmarkBufferUploadLargeShard` | Same path for an 8 MiB shard (`b.SetBytes` gives MB/s) |
| Transfer policy | `benchmark-webrtc` CLI | Backoff growth, stage timeouts, concurrency constants |
| Build/startup | `go build`, `cargo build --release`, process probes | Binary size, build time, startup latency, idle RSS |
| Correctness/scale | `pnpm test` | Full TypeScript, Go, and Rust suites |

### Environment

| Item | Value |
|---|---|
| CPU | Intel Core i5-11400H (6 cores / 12 threads, 2.70 GHz base) |
| RAM | 15 GiB |
| OS | Linux 7.2.5 (Omarchy/Arch), x86_64 |
| Node.js | v26.2.0 (repository declares `>=24 <25`; see caveats) |
| pnpm | 11.23.0 |
| Go | 1.27.0 |
| Rust | 1.96.1 |
| Storage | `/tmp` is tmpfs (memory-backed) |
| Run isolation | Single machine, no competing workload |

---

## 2. Results at a Glance

| Metric | Result |
|---|---|
| Shard splitting (64 MiB) | **~4.9–5.2 GiB/s** |
| AES-256-GCM encryption (64 MiB) | **~53–55 MiB/s** |
| BLAKE3 hashing (64 MiB) | **~53–55 MiB/s** |
| Full upload-side pipeline (64 MiB) | **~27.1–27.5 MiB/s** |
| Full download-side pipeline (64 MiB) | **~54.2–54.7 MiB/s** |
| FEK envelope seal | **~1.36–1.66 ms/op** (~600–735 ops/s) |
| FEK envelope open | **~0.653–0.666 ms/op** (~1,500–1,530 ops/s) |
| Filename encrypt / decrypt | **~52k–55k / ~61k–64k ops/s** |
| Relay 8 MiB shard ingest | **9.6–9.8 ms** (**~855–874 MB/s**) on tmpfs |
| Relay small-shard handler | **188–194 µs/op**, 191 allocs, ~24 KB/op |
| Transfer timing contract | **8/8 checks pass** |
| Relay release binary | **14 MB**, built in **12.8 s**, starts in **96 ms**, idle RSS **17.9 MB** |
| Storage Node release binary | **23 MB**, built in **49.0 s**, starts in **26 ms**, idle RSS **16.7 MB** |
| Web standalone bundle | **43 MB** standalone + **1.8 MB** static assets |
| Test suite | **96.5 s**, 654 TS tests + 482 Rust tests + 278 Go test funcs, all pass |

**Throughput extrapolation** (CPU only, before network):

| File size | Upload pipeline | Download pipeline |
|---|---|---|
| 64 MiB | ~2.36 s | ~1.17 s |
| 1 GiB | ~37.8 s | ~18.7 s |
| 10 GiB | ~6.3 min | ~3.1 min |

---

## 3. Client Crypto and Sharding

### 3.1 Method

- 64 MiB random payload, split into eight 8 MiB shards.
- FEK: 32 random bytes.
- Each result is the **median of five rounds**, after one warm-up round.
- Three independent full runs were performed; ranges below cover all three.
- `split`, `encrypt`, and `hash` are measured separately, then combined into the
  upload and download pipelines.
- The download pipeline decrypts all shards and reassembles them, verifying the
  output length.

### 3.2 Results

| Stage | Median time (64 MiB) | Throughput | Range across runs |
|---|---|---|---|
| Split | 12.28–13.07 ms | 4,898–5,213 MiB/s | stable |
| AES-256-GCM encrypt | 1,165–1,201 ms | 53.3–54.9 MiB/s | ±3% |
| BLAKE3 hash | 1,168–1,199 ms | 53.4–54.8 MiB/s | ±3% |
| **Upload pipeline** | **2,328–2,358 ms** | **27.1–27.5 MiB/s** | ±1% |
| **Download pipeline** | **1,170–1,181 ms** | **54.2–54.7 MiB/s** | ±1% |
| Envelope seal | 1.36–1.66 ms/op | 600–735 ops/s | higher variance |
| Envelope open | 0.653–0.666 ms/op | 1,500–1,530 ops/s | stable |
| Filename encrypt | 0.0181–0.0192 ms/op | 52,025–55,353 ops/s | stable |
| Filename decrypt | 0.0157–0.0163 ms/op | 61,210–63,535 ops/s | stable |

### 3.3 Interpretation

- **Sharding is effectively free** compared with crypto. The 5 GiB/s figure is
  dominated by memory copies (`.slice()` per shard).
- **Encryption and hashing each cost about the same** (~54 MiB/s). Running them
  sequentially halves throughput to ~27 MiB/s; this is exactly what the upload
  pipeline does today.
- **Download is ~2× faster than upload per byte** because it does not hash after
  encryption, and decryption plus reassembly is cheaper than
  split + encrypt + hash.
- **Envelopes are cheap per file.** At ~1.4–1.7 ms per recipient, sealing a file
  for 5 recipients costs ~7–8 ms once. This is negligible for normal files.
- **Filename crypto is negligible** at >50k operations/s.

> The implementation uses `@noble/ciphers` and `@noble/hashes`, which are pure
> JavaScript and do not use AES-NI. WebCrypto (`crypto.subtle`) would use the
> platform's AES-GCM implementation, and a WASM BLAKE3 build would replace the
> JavaScript hash. Both are the largest available client-side wins.

---

## 4. Relay Path C Ingest

### 4.1 Small-shard handler

`BenchmarkBufferUpload` uses a ~20-byte body, so it measures handler overhead
rather than throughput:

| Run | ns/op | Allocations |
|---|---|---|
| 1 | 193,615 | 24,021 B / 191 |
| 2 | 188,265 | 24,038 B / 191 |
| 3 | 192,069 | 24,033 B / 191 |
| 4 | 193,411 | 24,010 B / 191 |
| 5 | 192,069 | 24,038 B / 191 |

**~192 µs per shard** (~5,200 sequential shard-metadata operations/s), with
stable allocation volume. This path includes BLAKE3, the SQLite location update,
and the buffer file write.

### 4.2 Full 8 MiB shard

`BenchmarkBufferUploadLargeShard` uses the default shard size and `b.SetBytes`:

| Run | ns/op | Throughput | Allocations |
|---|---|---|---|
| 1 | 9,810,206 | 855.09 MB/s | 17,099,655 B / 245 |
| 2 | 9,601,900 | 873.64 MB/s | 17,098,858 B / 238 |
| 3 | 9,747,223 | 860.62 MB/s | 17,098,846 B / 241 |

**~9.6–9.8 ms per 8 MiB shard**, or **~855–874 MB/s**. This is an in-process
`httptest` run, with the buffer on **tmpfs**, so it excludes network, TLS, and
mechanical disk latency. It establishes that the Relay handler is not the
bottleneck for a single client; the ~17 MB of allocations per call is the body
and hash working set, not a leak.

### 4.3 Scaling implication

A 1 GiB file is 128 × 8 MiB shards. At the measured handler rate, Relay ingest
alone is ~1.23 s of CPU/memory work. The client crypto pipeline is ~37.8 s for
the same file, so **client CPU dominates end-to-end upload**. Real Wi-Fi and
TLS will add the remaining time.

---

## 5. Transfer Timing Contract

`pnpm --filter benchmark-webrtc benchmark:timings` verifies the deterministic
policy rather than live network negotiation:

| Check | Measured | Expected | Result |
|---|---|---|---|
| Backoff attempt 0 | 696.70 ms | ≥ 500 ms | PASS |
| Backoff attempt 1 | 1,195.37 ms | ≥ 1,000 ms | PASS |
| Backoff attempt 2 | 2,090.61 ms | ≥ 2,000 ms | PASS |
| Backoff attempt 3 | 4,295.53 ms | ≥ 4,000 ms | PASS |
| Local discovery timeout | 2,000 ms | 2,000 ms | PASS |
| WebRTC negotiation timeout | 4,000 ms | 4,000 ms | PASS |
| Relay signaling timeout | 3,000 ms | 3,000 ms | PASS |
| Max concurrency | 4 | 4 | PASS |

**8/8 pass.** The backoff values include jitter, so they exceed the base
`500 × 2^n` lower bound as designed. Live Path A/B negotiation was **not**
measured in this run; the browser harness (`scripts/benchmark-webrtc/bench.html`)
requires two real peers and is the intended tool for that matrix.

---

## 6. Build, Startup, and Memory Footprint

| Metric | Relay | Storage Node | Web |
|---|---|---|---|
| Language/runtime | Go 1.27 | Rust 1.96.1 (release) | Next.js standalone |
| Binary / artifact | 14 MB | 23 MB | 43 MB standalone + 1.8 MB static |
| Build time | 12.8 s | 49.0 s (deps compiled) | not re-measured |
| Startup | 96 ms to listening | 26 ms to “storage node running” | not re-measured |
| Idle RSS | 17.9 MB | 16.7 MB | not measured |
| Debug artifact | — | 271 MB (debug) | — |

Notes:

- The Relay startup probe ran without Redis, so it exercised the degraded path
  (SQLite + buffer + hub, ephemeral presence disabled). With Redis, expect a
  small additional connection cost.
- The Storage Node probe used a fresh data directory and an unreachable Relay;
  it still completed local boot, migrations, object-store recovery, and the
  reconciliation scan in 26 ms.
- `apps/web/.next` is 950 MB in total, but that includes build/dev caches. The
  deployable standalone server is 43 MB and static assets are 1.8 MB.
- Shared package build outputs are small: `core` 100 KB, `protocol` 316 KB,
  `sdk` 392 KB, `transfer-manager` 108 KB.

---

## 7. Test Suite Throughput

`pnpm test` completed in **96.5 s** with status 0.

| Suite | Result | Notes |
|---|---|---|
| TypeScript | **654 tests / 93 files** | 80 protocol, 12 webrtc, 56 relay-client, 15 transfer-manager, 58 core, 52 SDK, 41 mobile, 340 web |
| Go Relay | **278 test functions across 10 packages** | `internal/handler` 3.17 s; all packages pass |
| Rust Node | **482 tests** | 232 + 245 unit/integration, plus live WebRTC tests |
| Slowest tests | 41.1 s and 17.8 s | Live WebRTC integration tests |
| Doc tests | 0 | — |

The 41 s and 18 s live WebRTC tests dominate total wall time; unit and handler
suites complete in seconds. This is useful for CI planning: split the live
WebRTC tests into a separate job if wall-clock latency matters.

---

## 8. Improvements Already Implemented

These are performance/reliability optimizations present in the codebase, not
proposals.

| Area | Change | Effect |
|---|---|---|
| Downloads | Adaptive concurrency controller (`packages/sdk/src/download/adaptive/`) | Raises concurrency while throughput improves, backs off on degradation; releases network permits before verify/decrypt so CPU work does not occupy transfer slots |
| Downloads | Streaming progress and per-shard byte accounting | Live throughput/ETA instead of one jump per shard; failed shards do not freeze progress |
| WebRTC | Chunked 16 KiB shard streaming with flow control (`services/storage-node/src/webrtc/`) | Avoids one giant DataChannel message, bounding memory and keeping a slow peer from stalling the sender |
| Relay | Streaming shard downloads with per-chunk flush, idle budget, and short-read guard (`internal/handler/shard_fetch.go`) | Constant memory for large shards; stuck streams are reclaimed; oversized/undersized streams are cut off |
| Relay | Bounded concurrent shard fetches per account/global, with capacity shedding | Prevents one client from exhausting Relay memory |
| Relay | Binary `request_id` framing and multiplexed fetches | Several shard fetches can interleave on one node socket without head-of-line blocking at the protocol layer |
| Transfer | Path cache + immediate eviction on failure; exponential backoff with jitter (`packages/transfer-manager`) | Avoids re-probing a known-broken path; bounds retry storms |
| Transfer | Bounded concurrency pool (default 4) | Prevents unbounded parallel uploads/downloads from starving the UI or network |
| Storage Node | Streaming BLAKE3, bounded temp recovery (`store/write.rs`) | Does not read a whole shard into memory for hashing/recovery |
| Storage Node | Keyset pagination in reconciliation (`store/reconcile.rs`) | Avoids OFFSET row-skipping while mutating status; stable for large catalogues |
| Storage Node | Maintenance lock around GC/reconcile | Prevents races between refcount checks, writes, and deletions |
| SQLite | WAL + `busy_timeout` + `_txlock=immediate` writer (`internal/db/sqlite.go`) | Fewer `SQLITE_BUSY_SNAPSHOT` failures; readers do not block the writer |
| SQLite | Added hot-path indexes (`20260914000001_audit_indexes.sql`) | Avoids full scans for GC, reconciliation, folder rollups, and ordered lists |
| Web | 150 ms coalesced catalog revalidation; fallback poll 15 s → 60 s | Fewer renders and Relay calls during bursts |
| Mobile | ~100 ms download-progress coalescing | Avoids re-rendering the whole app per chunk |
| Mobile | Runtime Relay URL selection with health probe | No rebuild per server; failed servers are detected before session use |
| Security/ops | Rate limits, fetch caps, request size caps, single-use tokens | Protect availability under abuse or misconfiguration |
| CI | 654 TS + 482 Rust + 278 Go tests, live WebRTC tests | Catches performance-sensitive regressions in transfer/sync paths |

---

## 9. Bottleneck Analysis

### 9.1 Client CPU is the dominant cost

The measured upload pipeline is **27.1–27.5 MiB/s** on one core. This is the
single most important number for user-perceived upload latency:

- A 1 GiB file spends ~38 s in sharding/encryption/hashing before network time.
- A 10 GiB backup spends ~6.3 minutes of CPU.
- The network is idle during that work unless the client pipelines shard
  preparation with upload (it does some of this with concurrency, but the crypto
  itself is single-threaded JavaScript).

### 9.2 Pure-JS crypto versus hardware AES

`@noble/ciphers` is portable and audited, but it is not AES-NI. Browsers expose
hardware AES through `crypto.subtle.encrypt`, and BLAKE3 has fast WASM builds.
The current ~54 MiB/s for each stage is a **software** limit, not a disk or
network limit. On this CPU, AES-NI alone is typically multiple GB/s; the exact
gain must be measured after integration.

### 9.3 Relay is not the single-client bottleneck

At ~0.86 GB/s on tmpfs, the Relay handler is ~30× faster than the client upload
pipeline. Real disk and network will reduce that, but for a single client the
Relay should keep up. The relay does allocate ~17 MB per 8 MiB shard call, so
many concurrent large uploads will create memory pressure; the existing
per-account/global fetch caps address the download side, and the buffer upload
path should be load-tested with concurrent clients.

### 9.4 Single WebSocket per node caps Relay-path aggregate throughput

Path B/C transfers share one node↔Relay WebSocket. Even with client-side
concurrency, aggregate throughput through the Relay plateaus because frames are
multiplexed over one connection. This is a known follow-up in the changelog:
true parallel Relay bandwidth would need multiple node connections or a
different transport.

### 9.5 Memory amplification

`splitIntoShards` copies each shard (`.slice()`), then encryption creates another
copy per shard, and the upload pipeline holds the encrypted array. A 64 MiB file
with 8 shards can transiently hold roughly 3× the file size. For large files this
is the limiting factor before CPU on memory-constrained mobile devices. Streaming
one shard at a time (read → encrypt → hash → upload → release) would cap memory
at a few shards regardless of file size.

### 9.6 SQLite write serialization

SQLite is fast for this workload (the handler benchmark includes a write per
shard), but it has one writer. This is acceptable for a self-hosted relay with a
single node/account workload; it becomes the scaling limit for many concurrent
accounts. The WAL and `immediate` transaction settings reduce busy failures, but
they do not add write parallelism.

### 9.7 Envelopes are not a bottleneck

Sealing is ~1.4–1.7 ms per recipient. Even 20 recipients cost ~30 ms per file.
Do not optimize this before the file pipeline.

---

## 10. Recommended Improvements

### Priority 0 — highest impact

1. **Use WebCrypto AES-GCM for shard encryption.**
   Replace the synchronous `@noble/ciphers` call with `crypto.subtle.encrypt`
   (AES-GCM, 256-bit) where available, falling back to noble on platforms
   without WebCrypto. Expect a large gain from AES-NI; measure before claiming a
   multiplier. The API is async, so the uploader/downloader loops need to await
   per shard (they are already async).

2. **Use a WASM BLAKE3 implementation.**
   Hashing is the other half of the upload pipeline. A WASM build (or a native
   binding on mobile) should move this from ~54 MiB/s toward memory bandwidth.
   Keep the current pure-JS implementation as a fallback.

3. **Parallelize independent shards with a worker pool.**
   Shards are independent by design. Move encrypt+hash into Web Workers
   (browser) or `worker_threads` (Node/e2e), with a bounded pool sized to
   `navigator.hardwareConcurrency` (cap at 4–6). On this 6-core CPU, near-linear
   scaling is plausible until memory bandwidth or upload I/O becomes the limit.

4. **Stream the file instead of materializing all shards.**
   Read one shard, encrypt, hash, upload, release. This caps peak memory at
   `concurrency × shard size` instead of ~3× file size and makes multi-GB
   backups safe on mobile.

### Priority 1 — meaningful gains

5. **Add multiple node↔Relay connections (or HTTP/2 streams) for Path B/C.**
   One WebSocket per node is the aggregate ceiling for Relay-mediated transfers.
   A small pool of connections per node, with per-connection framing, would let
   client concurrency translate into Relay throughput.

6. **Batch metadata events.**
   A single upload currently emits file creation, envelopes, version, and shard
   manifest as separate batches/frames. Coalescing them into one atomic batch
   reduces round trips and journal writes, especially for many small files.

7. **Reuse HTTP connections and TLS sessions for Path C.**
   Confirm `keep-alive`, HTTP/2 where available, and TLS session resumption on
   the Next BFF → Relay and client → Relay hops. This mostly affects many-small-
   shard workloads, not large files.

8. **Add a concurrent Path C load benchmark.**
   The current 8 MiB benchmark is a single sequential handler call. A benchmark
   with 4/8/16 concurrent clients, real HTTP, and a disk-backed buffer would
   show where the Relay saturates and whether the current caps are right.

### Priority 2 — operational and UX

9. **Profile the web client.**
   Measure long tasks during large file selection, encryption, and download
   assembly. Consider `requestIdleCallback`/incremental shard preparation so the
   UI stays responsive.

10. **Measure live WebRTC negotiation and throughput.**
    Run the existing browser harness on the target Wi-Fi/NAT matrix and record
    Path A/B timings. The current result only verifies the timing contract, not
    real network behavior.

11. **Consider fsync batching in the node object store.**
    Each shard currently fsyncs the file and directory. Group commit could
    improve write throughput at the cost of a small durability window; only do
    this if benchmarks show fsync is the node bottleneck.

12. **Scale the Relay store only when needed.**
    SQLite is a good fit for the single-instance design. If concurrent-account
    write throughput becomes a limit, revisit the store rather than adding
    replicas to a process-locked database.

---

## 11. Caveats

- The machine is a laptop CPU (i5-11400H) and the Node runtime is **v26.2.0**,
  while the repository declares `>=24 <25`. Crypto and JIT performance may
  differ on the supported runtime and on mobile.
- Client crypto results are **pure JavaScript** and single-threaded. They are
  not a ceiling for WebCrypto/WASM implementations.
- The Relay 8 MiB benchmark uses `httptest` and a **tmpfs** buffer. It excludes
  TLS, real network, and disk; treat ~0.86 GB/s as an upper bound.
- No production database size, real LAN, or live WebRTC throughput was
  measured in this run.
- Medians over 5 rounds (file pipeline) or 3–5 benchmark runs (Relay) are
  reported; no confidence intervals are claimed.
- Build times depend on caches; the Storage Node release build had dependencies
  already compiled.
- The full test suite time includes live WebRTC integration tests (41 s and
  18 s), which dominate the 96.5 s total.

---

## 12. Reproducing the Results

```bash
# Client crypto/sharding pipeline
pnpm --filter @repo/core build
node scripts/perf/crypto-bench.mjs
# optional: --size-mb 256 --shard-mb 8 --rounds 5

# Relay small-shard handler
cd services/relay
go test ./internal/handler -run '^$' \
  -bench 'BenchmarkBufferUpload$' -benchmem -count=5 -benchtime=200x \
  > /tmp/buffer-bench.txt 2>&1
grep -E 'Benchmark|ok' /tmp/buffer-bench.txt

# Relay full 8 MiB shard
go test ./internal/handler -run '^$' \
  -bench 'BenchmarkBufferUploadLargeShard' -benchmem -count=3 -benchtime=20x \
  > /tmp/buffer-large-bench.txt 2>&1
grep -E 'ns/op|MB/s|ok' /tmp/buffer-large-bench.txt

# Transfer timing contract
cd ../..
pnpm --filter benchmark-webrtc benchmark:timings

# Release builds and footprint
(cd services/relay && go build -trimpath -ldflags='-s -w' -o /tmp/nodus-relay .)
cargo build --release --manifest-path services/storage-node/Cargo.toml

# Full suite
pnpm test
```

### Raw result files from this run

- `/tmp/buffer-bench.txt` — small-shard Go benchmark (5 runs)
- `/tmp/buffer-large-bench.txt` — 8 MiB Go benchmark (3 runs)
- `/tmp/nodus-test-all.log` — full test suite
- `/tmp/cargo-release.log` — release build

These are ephemeral; rerun the commands above to regenerate them.
