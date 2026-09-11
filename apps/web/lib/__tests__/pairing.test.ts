import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPairingCode, findNewNode, findNode, listNodes, type RelayNode } from "../pairing";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function node(partial: Partial<RelayNode> = {}): RelayNode {
  return {
    node_id: "node-1",
    account_id: "acct-1",
    public_key: "ab".repeat(32),
    capabilities: ["storage", "sync"],
    status: "ACTIVE",
    is_primary: true,
    last_seen_at: null,
    created_at: "2026-09-11T00:00:00.000Z",
    ...partial,
  };
}

describe("createPairingCode", () => {
  it("POSTs to the proxy and returns { code, expires_at }", async () => {
    const created = { code: "NODUS-ABCD-2345", expires_at: "2026-09-11T16:39:24Z" };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(created), { status: 201 }),
    );
    globalThis.fetch = fetchMock;

    await expect(createPairingCode()).resolves.toEqual(created);
    expect(fetchMock).toHaveBeenCalledWith("/api/pairing/codes", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
  });

  it("throws on a non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(createPairingCode()).rejects.toThrow("pairing code creation failed: 401");
  });

  it("surfaces the Relay's machine-readable error reason", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "rate_limit_exceeded" }), { status: 429 }),
    );
    await expect(createPairingCode()).rejects.toThrow("rate_limit_exceeded");
  });
});

describe("listNodes / findNode", () => {
  it("returns the node catalog from the proxy", async () => {
    const catalog = [node()];
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(catalog), { status: 200 }),
    );

    await expect(listNodes()).resolves.toEqual(catalog);
  });

  it("throws when the polling request fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 503 }));
    await expect(listNodes()).rejects.toThrow("failed to load nodes: 503");
  });

  it("findNode reports pending (undefined) then paired", () => {
    expect(findNode([], "node-1")).toBeUndefined();
    const catalog = [node({ node_id: "node-1" })];
    expect(findNode(catalog, "node-1")?.node_id).toBe("node-1");
    expect(findNode(catalog, "node-2")).toBeUndefined();
  });

  it("findNewNode detects a node absent from the baseline", () => {
    const baseline = ["node-1"];
    // Only pre-existing nodes: still pending.
    expect(findNewNode(baseline, [node({ node_id: "node-1" })])).toBeUndefined();
    // A new id appears: that is the freshly paired node.
    const found = findNewNode(baseline, [
      node({ node_id: "node-1" }),
      node({ node_id: "node-2" }),
    ]);
    expect(found?.node_id).toBe("node-2");
    // Empty baseline vs empty catalog stays pending.
    expect(findNewNode([], [])).toBeUndefined();
  });
});
