import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { autoPairCandidateHosts } from "../auto-pair";
import { fetchShardViaRelay } from "../download";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("autoPairCandidateHosts", () => {
  it("always probes loopback and dedupes the serving host first", () => {
    expect(autoPairCandidateHosts("")).toEqual(["127.0.0.1"]);
    expect(autoPairCandidateHosts("localhost")).toEqual(["127.0.0.1", "localhost"]);
    // Same candidate supplied twice collapses to one entry.
    expect(autoPairCandidateHosts("127.0.0.1")).toEqual(["127.0.0.1"]);
    // A scheme or trailing slash in a host string are kept as-is; the caller
    // is expected to pass a clean hostname from `location.hostname`.
    expect(autoPairCandidateHosts("http://nginx.Test/")).toEqual(["127.0.0.1", "http://nginx.test/"]);
  });
});

describe("fetchShardViaRelay", () => {
  it("returns raw bytes on success", async () => {
    const body = new Uint8Array([9, 8, 7, 6]);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));

    const result = await fetchShardViaRelay("ab".repeat(32));

    expect(result.ok).toBe(true);
    expect(Array.from(result.data as Uint8Array)).toEqual([9, 8, 7, 6]);
    expect(globalThis.fetch).toHaveBeenCalledWith(`/api/shard/${"ab".repeat(32)}`);
  });

  it("returns the relay error reason on a non-OK status", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "shard_unavailable" }), { status: 404 }));

    const result = await fetchShardViaRelay("cd".repeat(32));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("shard_unavailable");
  });

  it("surfaces network failure without throwing", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await fetchShardViaRelay("ef".repeat(32));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });
});

describe("ensureNodeTrusted", () => {
  const device = {
    device_id: "device-1",
    public_key: "ab",
    private_key: "cd",
  };

  it("skips work and reports already-paired when the node is trusted", async () => {
    vi.doMock("../trusted-nodes", () => ({
      getTrustedNodes: vi.fn().mockResolvedValue([{ node_id: "node-1" }]),
      addTrustedNode: vi.fn(),
    }));
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("must not be called"));

    const { ensureNodeTrusted } = await import("../auto-pair");
    await expect(ensureNodeTrusted("node-1")).resolves.toEqual({ paired: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns unpaired when no candidate advertises the target node", async () => {
    vi.doMock("../trusted-nodes", () => ({
      getTrustedNodes: vi.fn().mockResolvedValue([]),
      addTrustedNode: vi.fn(),
    }));
    vi.doMock("../pairing", () => ({
      issuePairingToken: vi.fn().mockRejectedValue(new Error("must not be called")),
    }));
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("refused"));

    const { ensureNodeTrusted } = await import("../auto-pair");
    await expect(ensureNodeTrusted("node-2")).resolves.toEqual({ paired: false });
  });

  it("pairs when a candidate advertises the target node", async () => {
    let saved: unknown = null;
    vi.doMock("../trusted-nodes", () => ({
      getTrustedNodes: vi.fn().mockResolvedValue([]),
      addTrustedNode: vi.fn(async (node) => {
        saved = node;
      }),
    }));
    vi.doMock("../pairing", () => ({
      issuePairingToken: vi
        .fn()
        .mockResolvedValue({ token: "tok-1", expires_at: "2026-09-11T16:39:24Z" }),
    }));
    vi.doMock("../device", () => ({
      getOrCreateDeviceIdentity: vi.fn().mockReturnValue(device),
    }));

    const discovery = {
      node_id: "node-2",
      account_id: "acct-2",
      public_key: "ab".repeat(32),
      schema_version: "1.8",
    };
    // Two real fetches happen (token issuance is mocked away): the discovery
    // advertisement, then the node's /nodus/pair redeem.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(discovery), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ node_id: "node-2", account_id: "acct-2" }), { status: 200 }));

    const { ensureNodeTrusted } = await import("../auto-pair");
    const result = await ensureNodeTrusted("node-2");

    expect(result.paired).toBe(true);
    expect(result.host).toBe("127.0.0.1");
    expect(saved).toEqual(
      expect.objectContaining({ node_id: "node-2", host: "127.0.0.1", device_id: "device-1" }),
    );
  });
});