import { describe, expect, it } from "vitest";
import type { FileId, Shard, ShardMetadata } from "./types.js";
import {
  SHARD_SIZE_BYTES,
  reconstructFromShards,
  splitIntoShards,
} from "./shard.js";

const fileId = "file-1" as FileId;

function bytesOf(length: number, fill = 0): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/**
 * Fast byte-wise equality. `expect(...).toEqual()` on 8 MB `Uint8Array`s is
 * slow and drives GC pressure; a direct loop is ~10 ms for 8 MB.
 */
function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`byte mismatch at offset ${i}`);
    }
  }
}

function fromShards(shards: Shard[]): ShardMetadata[] {
  return shards.map((s) => ({
    fileId: s.fileId,
    index: s.index,
    size: s.data.length,
    hash: null,
  }));
}

describe("splitIntoShards", () => {
  it("splits a 0-byte file into exactly one 0-byte shard", () => {
    const shards = splitIntoShards(fileId, bytesOf(0));
    expect(shards).toHaveLength(1);
    expect(shards[0]?.data.length).toBe(0);
    expect(shards[0]?.index).toBe(0);
  });

  it("splits a 1-byte file into one 1-byte shard", () => {
    const shards = splitIntoShards(fileId, bytesOf(1, 7));
    expect(shards).toHaveLength(1);
    expect(shards[0]?.data.length).toBe(1);
    expect(shards[0]?.data[0]).toBe(7);
  });

  it("splits exactly SHARD_SIZE_BYTES into one full shard, no trailing empty", () => {
    const shards = splitIntoShards(fileId, bytesOf(SHARD_SIZE_BYTES));
    expect(shards).toHaveLength(1);
    expect(shards[0]?.data.length).toBe(SHARD_SIZE_BYTES);
  });

  it("splits SHARD_SIZE_BYTES + 1 into two shards (full + 1-byte remainder)", () => {
    const shards = splitIntoShards(fileId, bytesOf(SHARD_SIZE_BYTES + 1));
    expect(shards).toHaveLength(2);
    expect(shards[0]?.data.length).toBe(SHARD_SIZE_BYTES);
    expect(shards[1]?.data.length).toBe(1);
  });

  it("splits a multi-shard file with a non-even remainder", () => {
    const length = SHARD_SIZE_BYTES * 3 + 12345;
    const shards = splitIntoShards(fileId, bytesOf(length));
    expect(shards).toHaveLength(4);
    expect(shards[0]?.data.length).toBe(SHARD_SIZE_BYTES);
    expect(shards[1]?.data.length).toBe(SHARD_SIZE_BYTES);
    expect(shards[2]?.data.length).toBe(SHARD_SIZE_BYTES);
    expect(shards[3]?.data.length).toBe(12345);
  });

  it("indexes shards 0-based in order", () => {
    const shards = splitIntoShards(fileId, bytesOf(SHARD_SIZE_BYTES * 2 + 1));
    expect(shards.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("leaves hash null after splitting (Phase 2 does no hashing)", () => {
    const shards = splitIntoShards(fileId, bytesOf(100));
    const metadata = fromShards(shards);
    for (const m of metadata) {
      expect(m.hash).toBeNull();
    }
  });
});

describe("reconstructFromShards", () => {
  it("round-trips a 0-byte file to a 0-byte Uint8Array", () => {
    const original = bytesOf(0);
    const shards = splitIntoShards(fileId, original);
    expectBytesEqual(reconstructFromShards(shards), original);
  });

  it("round-trips a 1-byte file", () => {
    const original = bytesOf(1, 42);
    expectBytesEqual(reconstructFromShards(splitIntoShards(fileId, original)), original);
  });

  it("round-trips exactly SHARD_SIZE_BYTES", () => {
    const original = bytesOf(SHARD_SIZE_BYTES, 9);
    expectBytesEqual(
      reconstructFromShards(splitIntoShards(fileId, original)),
      original,
    );
  });

  it("round-trips SHARD_SIZE_BYTES + 1", () => {
    const original = bytesOf(SHARD_SIZE_BYTES + 1, 3);
    expectBytesEqual(
      reconstructFromShards(splitIntoShards(fileId, original)),
      original,
    );
  });

  it("round-trips a multi-shard file with a non-even remainder", () => {
    const original = bytesOf(SHARD_SIZE_BYTES * 4 + 777, 5);
    expectBytesEqual(
      reconstructFromShards(splitIntoShards(fileId, original)),
      original,
    );
  });

  it("sorts out-of-order but complete shards and succeeds", () => {
    const original = bytesOf(SHARD_SIZE_BYTES * 2 + 1, 2);
    const shards = splitIntoShards(fileId, original);
    const reversed = [...shards].reverse();
    expectBytesEqual(reconstructFromShards(reversed), original);
  });

  it("throws on a genuine gap in the index sequence", () => {
    // 3 shards (indices 0, 1, 2); drop index 1 to create a real gap.
    const shards = splitIntoShards(fileId, bytesOf(SHARD_SIZE_BYTES * 2 + 1));
    const gapped = shards.filter((s) => s.index !== 1);
    expect(() => reconstructFromShards(gapped)).toThrow(/gap/i);
  });

  it("throws on duplicate indices", () => {
    const shards = splitIntoShards(fileId, bytesOf(SHARD_SIZE_BYTES));
    expect(() =>
      reconstructFromShards([shards[0] as Shard, shards[0] as Shard]),
    ).toThrow(/duplicate/i);
  });

  it("throws on empty input", () => {
    expect(() => reconstructFromShards([])).toThrow();
  });
});
