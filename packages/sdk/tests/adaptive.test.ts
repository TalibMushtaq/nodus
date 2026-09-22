import { describe, expect, it } from "vitest";
import {
  encryptShard,
  generateFileEncryptionKey,
  hashShard,
  packEncryptedShard,
} from "@repo/core";
import type { FileId, ShardIndex } from "@repo/core";

import {
  DownloadCancelledError,
  ShardIntegrityError,
  downloadFile,
} from "../src/download/download.js";
import type { DownloadDeps, RelayFileLocation } from "../src/download/download.js";
import { DownloadLimiter } from "../src/download/adaptive/pool.js";
import { ThroughputSampler } from "../src/download/adaptive/sampler.js";
import { AdaptiveConcurrencyController } from "../src/download/adaptive/controller.js";

const fileId = "file-1" as FileId;

function setup(shards: Uint8Array[], fek: Uint8Array) {
  const packed = shards.map((data, index) =>
    packEncryptedShard(encryptShard({ fileId, index: index as ShardIndex, data }, fek)),
  );
  const locations: RelayFileLocation[] = packed.map((bytes, index) => ({
    version_number: 1,
    shard_index: index,
    node_id: "node-1",
    status: "NODE_STORED",
    hash: hashShard(bytes),
    size_bytes: bytes.length,
  }));
  return { packed, locations };
}

function depsFor(
  fek: Uint8Array,
  packed: Uint8Array[],
  locations: RelayFileLocation[],
): DownloadDeps {
  return {
    fetchFileKey: async () => fek,
    getShardLocations: async () => locations,
    fetchShard: async (_fileId, location) => packed[location.shard_index]!,
  };
}

describe("ThroughputSampler", () => {
  it("reports an EWMA goodput that follows arriving bytes", () => {
    const clock = { now: 0 };
    const sampler = new ThroughputSampler(() => clock.now);
    sampler.record(500, 0);
    clock.now = 1000;
    sampler.record(500, 1000);
    // ~1000 bytes over ~1s.
    expect(sampler.bytesPerSecond).toBeGreaterThan(800);
    expect(sampler.bytesPerSecond).toBeLessThan(1200);
  });

  it("counts and resets errors", () => {
    const sampler = new ThroughputSampler(() => 0);
    sampler.recordError();
    expect(sampler.errorCount).toBe(1);
    sampler.resetErrors();
    expect(sampler.errorCount).toBe(0);
  });
});

describe("AdaptiveConcurrencyController", () => {
  it("ramps up while goodput improves and clamps at max", () => {
    const clock = { now: 0 };
    const sampler = new ThroughputSampler(() => clock.now);
    const changes: number[] = [];
    const controller = new AdaptiveConcurrencyController(
      { min: 1, max: 4, start: 2 },
      sampler,
      () => clock.now,
      (limit) => changes.push(limit),
    );

    // Establish a baseline (first probe sets prev, no change).
    sampler.record(1000, 0);
    clock.now = 1000;
    controller.onShardComplete(1000);
    controller.onShardComplete(1000);
    expect(controller.currentLimit).toBe(2);

    // Each probe window shows more goodput, so the limit climbs one at a time
    // and never past max.
    for (let i = 2; i <= 6; i += 1) {
      clock.now = i * 1000;
      sampler.record(5000, clock.now);
      controller.onShardComplete(clock.now);
      controller.onShardComplete(clock.now);
    }
    expect(controller.currentLimit).toBe(4);
    expect(changes).toEqual([3, 4]);
  });

  it("halves on errors and never drops below min", () => {
    const clock = { now: 0 };
    const sampler = new ThroughputSampler(() => clock.now);
    const controller = new AdaptiveConcurrencyController({ min: 1, max: 8, start: 4 }, sampler, () => clock.now);

    sampler.record(1000, 0);
    clock.now = 1000;
    controller.onShardComplete(1000);
    controller.onShardComplete(1000);
    sampler.recordError();
    clock.now = 2000;
    controller.onShardComplete(2000);
    controller.onShardComplete(2000);
    expect(controller.currentLimit).toBe(2);

    sampler.recordError();
    clock.now = 4000;
    controller.onShardComplete(4000);
    controller.onShardComplete(4000);
    expect(controller.currentLimit).toBe(1);
  });
});

describe("DownloadLimiter", () => {
  it("gates concurrency at the limit and releases slots", async () => {
    const limiter = new DownloadLimiter({ min: 1, max: 2, start: 2, now: () => 0 });
    const releaseA = await limiter.acquire();
    const releaseB = await limiter.acquire();
    expect(limiter.activeCount).toBe(2);

    let thirdGranted = false;
    const third = limiter.acquire().then((release) => {
      thirdGranted = true;
      return release;
    });
    await Promise.resolve();
    expect(thirdGranted).toBe(false);

    releaseA();
    const releaseC = await third;
    expect(thirdGranted).toBe(true);
    expect(limiter.activeCount).toBe(2);

    releaseB();
    releaseC();
    expect(limiter.activeCount).toBe(0);
  });

  it("rejects an acquire that is aborted while queued", async () => {
    const limiter = new DownloadLimiter({ min: 1, max: 1, start: 1, now: () => 0 });
    const release = await limiter.acquire();
    const controller = new AbortController();
    const queued = limiter.acquire(controller.signal);
    controller.abort();
    await expect(queued).rejects.toThrow(/aborted/);
    release();
  });
});

describe("downloadFile with an adaptive limiter", () => {
  it("fetches shards in parallel, restores order, and reports concurrency", async () => {
    const fek = generateFileEncryptionKey();
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const { packed, locations } = setup(
      [original.slice(0, 3), original.slice(3, 6), original.slice(6, 9), original.slice(9)],
      fek,
    );

    let inFlight = 0;
    let peak = 0;
    const limiter = new DownloadLimiter({ min: 1, max: 4, start: 4, now: () => 0 });
    const deps: DownloadDeps = {
      fetchFileKey: async () => fek,
      getShardLocations: async () => locations,
      fetchShard: async (_fileId, location) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Yield so parallel workers actually overlap.
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        return packed[location.shard_index]!;
      },
    };

    const seenConcurrency: number[] = [];
    const result = await downloadFile({
      fileId,
      versionNumber: 1,
      shardCount: 4,
      deps,
      limiter,
      onProgress: (event) => {
        if (event.concurrency != null) seenConcurrency.push(event.concurrency);
      },
    });

    expect(result.data).toEqual(original);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(seenConcurrency.length).toBeGreaterThan(0);
  });

  it("surfaces an integrity failure from a parallel worker", async () => {
    const fek = generateFileEncryptionKey();
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const { packed, locations } = setup(
      [original.slice(0, 3), original.slice(3, 6), original.slice(6, 9), original.slice(9)],
      fek,
    );
    // Corrupt one shard's recorded hash so verification fails.
    locations[2] = { ...locations[2]!, hash: "0".repeat(64) };

    const limiter = new DownloadLimiter({ min: 1, max: 4, start: 4, now: () => 0 });
    await expect(
      downloadFile({ fileId, versionNumber: 1, shardCount: 4, deps: depsFor(fek, packed, locations), limiter }),
    ).rejects.toBeInstanceOf(ShardIntegrityError);
  });

  it("cancels in-flight work via the abort signal", async () => {
    const fek = generateFileEncryptionKey();
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const { packed, locations } = setup(
      [original.slice(0, 3), original.slice(3, 6), original.slice(6, 9), original.slice(9)],
      fek,
    );

    const controller = new AbortController();
    const limiter = new DownloadLimiter({ min: 1, max: 2, start: 2, now: () => 0 });
    const deps: DownloadDeps = {
      fetchFileKey: async () => fek,
      getShardLocations: async () => locations,
      fetchShard: async (_fileId, location, _onProgress, signal) => {
        controller.abort();
        if (signal?.aborted) throw new Error("aborted");
        return packed[location.shard_index]!;
      },
    };

    await expect(
      downloadFile({
        fileId,
        versionNumber: 1,
        shardCount: 4,
        deps,
        limiter,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(DownloadCancelledError);
  });
});
