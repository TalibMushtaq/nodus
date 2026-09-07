# WebRTC negotiation benchmark harness

Standalone benchmark for the Transfer Manager's WebRTC negotiation timing
(spec: `docs/architecture/transfer-manager-spec.md`, §Transient failures).

Two parts:

1. **CLI (`.src/reporter.ts`)** — runs `pnpm benchmark:timings`. Verifies the
   deterministic timing contract: exponential backoff growth
   (`base * 2^attempt + [0, jitter)`) and the per-stage timeout table
   (local discovery 2000ms, WebRTC negotiation 4000ms, relay signaling 3000ms,
   max concurrency 4). Exits nonzero on any failure. This is the
   CI-runnable half — it measures logic, not the network.
2. **Browser harness (`bench.html`)** — the real-network half. Browsers have
   native `RTCPeerConnection`; Node does not, so real negotiation must be
   measured from a page.

## Running the CLI half

```bash
pnpm install
pnpm --filter benchmark-webrtc benchmark:timings
```

## Running the real-network half

1. Serve `bench.html` from anywhere (the imports are bundled from workspace
   packages — dev-server via `pnpm --filter benchmark-webrtc` with a static
   server, or copy to a phone/laptop on the network under test).
2. Fill in the form:
   - **Path A** (local signaling): set the node's local HTTP base, e.g.
     `http://192.168.1.50:9378`, and the answering peer must be reachable on
     that LAN (second browser tab paired to the node, or another Nodus node).
   - **Path B** (relay signaling): set the relay WS URL and the target node_id.
3. Run N rounds. Save the JSON report and append it to
   `docs/architecture/webrtc-benchmark-results.md`.

## Test matrix (run each cell on the devices under test)

| Network condition            | Path A (local signaling) | Path B (relay signaling) |
| ---------------------------- | ------------------------ | ------------------------ |
| Same-subnet Wi-Fi            | x ms                     | x ms                     |
| Different-subnet Wi-Fi       | (expected fail)          | x ms                     |
| Symmetric NAT (STUN only)    | (expected fail)          | x ms                     |
| CGNAT / Port-restricted NAT  | (expected fail)          | x ms                     |

Success criterion: Path B negotiation completes under the 4000ms spec timeout
on Wi-Fi; Path A is expected to fail off-LAN and fall back to Path B in the
manager.