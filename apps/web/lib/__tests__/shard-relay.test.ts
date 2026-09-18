import "fake-indexeddb/auto";
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
  // Public-only identity (ADR-0008); signing is a separate handle.
  const device = {
    device_id: "device-1",
    public_key: "ab",
  };
  const discovery = {
    node_id: "node-1",
    account_id: "acct-1",
    public_key: "ab".repeat(32),
    schema_version: "1.8",
  };

  /** Route node HTTP calls by path so multi-step flows read clearly. */
  function routeFetch(
    handlers: Partial<Record<"discovery" | "challenge" | "auth" | "pair", () => Response>>,
  ) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/nodus/discovery")) return handlers.discovery?.() ?? new Response(null, { status: 404 });
      if (url.endsWith("/nodus/challenge")) return handlers.challenge?.() ?? new Response(null, { status: 404 });
      if (url.endsWith("/nodus/auth")) return handlers.auth?.() ?? new Response(null, { status: 404 });
      if (url.endsWith("/nodus/pair")) return handlers.pair?.() ?? new Response(null, { status: 404 });
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it("re-verifies a cached node and stays paired while it still recognizes the device", async () => {
    vi.doMock("../trusted-nodes", () => ({
      getTrustedNodes: vi.fn().mockResolvedValue([{ node_id: "node-1", host: "127.0.0.1" }]),
      addTrustedNode: vi.fn(),
    }));
    vi.doMock("../pairing", () => ({
      // A cached-but-valid pairing must not mint a new token.
      issuePairingToken: vi.fn().mockRejectedValue(new Error("must not be called")),
    }));
    vi.doMock("../device", () => ({
      getOrCreateDevice: vi.fn().mockResolvedValue({ identity: device, signer: { sign: vi.fn().mockResolvedValue("00".repeat(64)) } }),
    }));
    globalThis.fetch = routeFetch({
      discovery: () => new Response(JSON.stringify(discovery), { status: 200 }),
      challenge: () => new Response(JSON.stringify({ nonce: "n-1", ttl_seconds: 60 }), { status: 200 }),
      auth: () => new Response(JSON.stringify({ status: "ok", node_id: "node-1" }), { status: 200 }),
    });

    const { ensureNodeTrusted } = await import("../auto-pair");
    await expect(ensureNodeTrusted("node-1")).resolves.toEqual({
      paired: true,
      host: "127.0.0.1",
    });
  });

  it("re-pairs when the node has forgotten this device", async () => {
    let saved: unknown = null;
    vi.doMock("../trusted-nodes", () => ({
      getTrustedNodes: vi.fn().mockResolvedValue([{ node_id: "node-1", host: "127.0.0.1" }]),
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
      getOrCreateDevice: vi.fn().mockResolvedValue({ identity: device, signer: { sign: vi.fn().mockResolvedValue("00".repeat(64)) } }),
    }));
    // First auth (the staleness check) rejects; the re-pair's own discovery and
    // pair then succeed.
    let authCalls = 0;
    globalThis.fetch = routeFetch({
      discovery: () => new Response(JSON.stringify(discovery), { status: 200 }),
      challenge: () => new Response(JSON.stringify({ nonce: "n-1", ttl_seconds: 60 }), { status: 200 }),
      auth: () => {
        authCalls += 1;
        return authCalls === 1
          ? new Response(JSON.stringify({ error: "unknown_device" }), { status: 401 })
          : new Response(JSON.stringify({ status: "ok", node_id: "node-1" }), { status: 200 });
      },
      pair: () =>
        new Response(JSON.stringify({ node_id: "node-1", account_id: "acct-1" }), {
          status: 200,
        }),
    });

    const { ensureNodeTrusted } = await import("../auto-pair");
    const result = await ensureNodeTrusted("node-1");

    expect(result.paired).toBe(true);
    expect(result.host).toBe("127.0.0.1");
    expect(saved).toEqual(
      expect.objectContaining({ node_id: "node-1", host: "127.0.0.1", device_id: "device-1" }),
    );
  });

  it("returns unpaired when no candidate advertises the target node", async () => {
    vi.doMock("../trusted-nodes", () => ({
      getTrustedNodes: vi.fn().mockResolvedValue([]),
      addTrustedNode: vi.fn(),
    }));
    vi.doMock("../pairing", () => ({
      issuePairingToken: vi.fn().mockRejectedValue(new Error("must not be called")),
    }));
    vi.doMock("../device", () => ({
      getOrCreateDevice: vi.fn().mockResolvedValue({ identity: device, signer: { sign: vi.fn().mockResolvedValue("00".repeat(64)) } }),
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
      getOrCreateDevice: vi
        .fn()
        .mockResolvedValue({ identity: device, signer: { sign: vi.fn().mockResolvedValue("00".repeat(64)) } }),
    }));

    const target = { ...discovery, node_id: "node-2", account_id: "acct-2" };
    // Two real fetches happen (token issuance is mocked away): the discovery
    // advertisement, then the node's /nodus/pair redeem.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(target), { status: 200 }))
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