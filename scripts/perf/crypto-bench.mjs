// Client-side crypto/sharding benchmark for the @repo/core pipeline.
//
// Measures the work a client does before bytes reach the network: shard
// splitting, AES-256-GCM encryption, BLAKE3 hashing, and the reverse
// download pipeline (decrypt + reassemble), plus FEK envelope and filename
// crypto. This is intentionally CPU-only: it does not include HTTP, WebRTC,
// disk I/O, or Relay latency.
//
// Run after building @repo/core:
//   pnpm --filter @repo/core build
//   node scripts/perf/crypto-bench.mjs [--size-mb 64] [--shard-mb 8] [--rounds 5]
//
// The implementation uses @noble/ciphers and @noble/hashes (pure JavaScript),
// so results are single-threaded and do not use AES-NI unless the runtime
// exposes it through WebCrypto. Use the figures as a baseline for the current
// implementation, not as a hardware ceiling.

import { randomFillSync } from "node:crypto";
const core = await import(
  new URL("../../packages/core/dist/index.js", import.meta.url).href
);

const MiB = 1024 * 1024;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const sizeMiB = arg("size-mb", 64);
const shardMiB = arg("shard-mb", 8);
const rounds = arg("rounds", 5);
const size = sizeMiB * MiB;
const shardSize = shardMiB * MiB;

const data = new Uint8Array(size);
randomFillSync(data);
const fek = core.generateFileEncryptionKey();
const fileId = "perf-bench";

function measureMs(fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  const end = process.hrtime.bigint();
  return { ms: Number(end - start) / 1e6, result };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function bench(label, fn, bytes = size) {
  fn(); // Warm up V8 and the crypto paths before recording.
  const samples = [];
  let result;
  for (let i = 0; i < rounds; i += 1) {
    const measured = measureMs(fn);
    samples.push(measured.ms);
    result = measured.result;
  }
  const med = median(samples);
  const throughput = bytes / MiB / (med / 1000);
  console.log(
    `${label}\t${med.toFixed(2)} ms\t${throughput.toFixed(1)} MiB/s\t` +
      `min ${Math.min(...samples).toFixed(2)} / max ${Math.max(...samples).toFixed(2)} ms`,
  );
  return result;
}

console.log(
  `payload ${sizeMiB} MiB · shard ${shardMiB} MiB · ${rounds} rounds · Node ${process.version}`,
);

const shards = bench("split", () => core.splitIntoShards(fileId, data, shardSize));
console.log(`shards ${shards.length}`);
const encrypted = bench("encrypt (AES-256-GCM)", () =>
  shards.map((shard) => core.encryptShard(shard, fek)),
);
bench("hash (BLAKE3)", () =>
  encrypted.map((shard) => core.hashShard(core.packEncryptedShard(shard))),
);
const uploadShards = bench("upload pipeline", () => {
  const split = core.splitIntoShards(fileId, data, shardSize);
  const sealed = split.map((shard) => core.encryptShard(shard, fek));
  for (const shard of sealed) core.hashShard(core.packEncryptedShard(shard));
  return sealed;
});
const restored = bench("download pipeline", () =>
  core.reconstructFromShards(
    uploadShards.map((shard) => core.decryptShard(shard, fek)),
  ),
);
if (restored.length !== data.length) {
  throw new Error(`reassembled ${restored.length} bytes, expected ${data.length}`);
}

const recipient = core.generateEncryptionKeypair();
const envelope = core.sealFekForRecipient(fek, recipient.publicKey);
const envelopeOps = 500;
let start = process.hrtime.bigint();
for (let i = 0; i < envelopeOps; i += 1) {
  core.sealFekForRecipient(fek, recipient.publicKey);
}
let end = process.hrtime.bigint();
console.log(
  `envelope seal\t${(Number(end - start) / 1e6 / envelopeOps).toFixed(4)} ms/op\t` +
    `${Math.round(envelopeOps / (Number(end - start) / 1e9))} ops/s`,
);
start = process.hrtime.bigint();
for (let i = 0; i < envelopeOps; i += 1) {
  core.openFekEnvelope(envelope, recipient.privateKey);
}
end = process.hrtime.bigint();
console.log(
  `envelope open\t${(Number(end - start) / 1e6 / envelopeOps).toFixed(4)} ms/op\t` +
    `${Math.round(envelopeOps / (Number(end - start) / 1e9))} ops/s`,
);

const name = "quarterly-report-2026-final.pdf";
const encryptedName = core.encryptName(name, fek);
const nameOps = 10_000;
start = process.hrtime.bigint();
for (let i = 0; i < nameOps; i += 1) core.encryptName(name, fek);
end = process.hrtime.bigint();
console.log(
  `name encrypt\t${(Number(end - start) / 1e6 / nameOps).toFixed(4)} ms/op\t` +
    `${Math.round(nameOps / (Number(end - start) / 1e9))} ops/s`,
);
start = process.hrtime.bigint();
for (let i = 0; i < nameOps; i += 1) core.decryptName(encryptedName, fek);
end = process.hrtime.bigint();
console.log(
  `name decrypt\t${(Number(end - start) / 1e6 / nameOps).toFixed(4)} ms/op\t` +
    `${Math.round(nameOps / (Number(end - start) / 1e9))} ops/s`,
);
