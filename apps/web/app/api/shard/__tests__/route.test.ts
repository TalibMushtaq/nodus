import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRelayFetchRaw } = vi.hoisted(() => ({ mockRelayFetchRaw: vi.fn() }));

vi.mock("../../../../lib/relay", () => ({
  relayFetchRaw: mockRelayFetchRaw,
  RELAY_SESSION_COOKIE: "nodus_session",
}));

import { GET } from "../[hash]/route";

const HASH = "ab".repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/shard/[hash]", () => {
  it("rejects a non-BLAKE3 hash before contacting the Relay", async () => {
    const response = await GET(new Request("http://localhost/api/shard/nope") as never, {
      params: Promise.resolve({ hash: "nope" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid shard hash" });
    expect(mockRelayFetchRaw).not.toHaveBeenCalled();
  });

  it("proxies a valid hash", async () => {
    mockRelayFetchRaw.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const response = await GET(
      new Request(`http://localhost/api/shard/${HASH}`, {
        headers: { cookie: "nodus_session=test-session" },
      }) as never,
      {
        params: Promise.resolve({ hash: HASH }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockRelayFetchRaw).toHaveBeenCalledWith(`/shards/${HASH}`, { method: "GET" });
  });
});
