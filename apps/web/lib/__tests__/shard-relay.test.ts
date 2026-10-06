import "fake-indexeddb/auto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { localNodeAuthMessage, localPairConfirmMessage } from "@repo/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { autoPairCandidateHosts } from "../auto-pair";
import { DownloadCancelledError, fetchShardViaRelay } from "../download";

const ORIGINAL_FETCH = globalThis.fetch;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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

  it("re-throws an abort as a cancellation instead of a shard failure", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new DOMException("aborted", "AbortError"));
    controller.abort();

    await expect(fetchShardViaRelay("aa".repeat(32), undefined, controller.signal)).rejects.toBeInstanceOf(
      DownloadCancelledError,
    );
  });
});

describe("ensureNodeTrusted", () => {
  // Public-only identity (ADR-0008); signing is a separate handle.
  const device = {
    device_id: "device-1",
    public_key: "ab",
  };
  // A real node_id is the hex of the node's Ed25519 public key, so the
  // advertisement must present a matching public_key and sign its challenges.
  const nodeAKey = ed25519.utils.randomPrivateKey();
  const nodeBKey = ed25519.utils.randomPrivateKey();
  const NODE_A = hex(ed25519.getPublicKey(nodeAKey));
  const NODE_B = hex(ed25519.getPublicKey(nodeBKey));
  const discovery = {
    node_id: NODE_A,
    account_id: "acct-1",
    public_key: NODE_A,
    schema_version: "1.8",
  };

  /** A node-signed challenge body, mirroring the Rust `/nodus/challenge`. */
  function signedChallengeResponse(
    nonce: string,
    key: Uint8Array,
    nodeId: string,
  ): Response {
    const signature = hex(
      ed25519.sign(new TextEncoder().encode(localNodeAuthMessage(nonce)), key),
    );
    return new Response(
      JSON.stringify({
        nonce,
        ttl_seconds: 60,
        node_id: nodeId,
        public_key: nodeId,
        node_signature: signature,
      }),
      { status: 200 },
    );
  }

  /** A node-signed pairing confirm, mirroring the Rust `/nodus/pair`. */
  function signedPairConfirm(
    key: Uint8Array,
    nodeId: string,
    devicePubkeyHex: string,
  ): Response {
    const signature = hex(
      ed25519.sign(
        new TextEncoder().encode(
          localPairConfirmMessage(nodeId, "device-1", devicePubkeyHex),
        ),
        key,
      ),
    );
    return new Response(
      JSON.stringify({
        node_id: nodeId,
        account_id: "acct-1",
        device_id: "device-1",
        device_public_key: devicePubkeyHex,
        node_signature: signature,
      }),
      { status: 200 },
    );
  }

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
      getTrustedNodes: vi.fn().mockResolvedValue([{ node_id: NODE_A, host: "127.0.0.1" }]),
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
      challenge: () => signedChallengeResponse("n-1", nodeAKey, NODE_A),
      auth: () => new Response(JSON.stringify({ status: "ok", node_id: NODE_A }), { status: 200 }),
    });

    const { ensureNodeTrusted } = await import("../auto-pair");
    await expect(ensureNodeTrusted(NODE_A)).resolves.toEqual({
      paired: true,
      host: "127.0.0.1",
    });
  });

  it("re-pairs when the node has forgotten this device", async () => {
    let saved: unknown = null;
    vi.doMock("../trusted-nodes", () => ({
      getTrustedNodes: vi.fn().mockResolvedValue([{ node_id: NODE_A, host: "127.0.0.1" }]),
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
      challenge: () => signedChallengeResponse("n-1", nodeAKey, NODE_A),
      auth: () => {
        authCalls += 1;
        return authCalls === 1
          ? new Response(JSON.stringify({ error: "unknown_device" }), { status: 401 })
          : new Response(JSON.stringify({ status: "ok", node_id: NODE_A }), { status: 200 });
      },
      pair: () => signedPairConfirm(nodeAKey, NODE_A, "ab".repeat(32)),
    });

    const { ensureNodeTrusted } = await import("../auto-pair");
    const result = await ensureNodeTrusted(NODE_A);

    expect(result.paired).toBe(true);
    expect(result.host).toBe("127.0.0.1");
    expect(saved).toEqual(
      expect.objectContaining({ node_id: NODE_A, host: "127.0.0.1", device_id: "device-1" }),
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
    await expect(ensureNodeTrusted(NODE_B)).resolves.toEqual({ paired: false });
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

    const target = { ...discovery, node_id: NODE_B, public_key: NODE_B, account_id: "acct-2" };
    // Two real fetches happen (token issuance is mocked away): the discovery
    // advertisement, then the node's /nodus/pair redeem.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(target), { status: 200 }))
      .mockResolvedValueOnce(signedPairConfirm(nodeBKey, NODE_B, "cd".repeat(32)));

    const { ensureNodeTrusted } = await import("../auto-pair");
    const result = await ensureNodeTrusted(NODE_B);

    expect(result.paired).toBe(true);
    expect(result.host).toBe("127.0.0.1");
    expect(saved).toEqual(
      expect.objectContaining({ node_id: NODE_B, host: "127.0.0.1", device_id: "device-1" }),
    );
  });
});