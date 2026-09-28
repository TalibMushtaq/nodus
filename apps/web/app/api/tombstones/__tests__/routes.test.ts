import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRelayFetch } = vi.hoisted(() => ({ mockRelayFetch: vi.fn() }));

vi.mock("../../../../lib/relay", () => ({
  relayFetch: mockRelayFetch,
  relayErrorMessage: ({ json }: { json: { error?: string } | null }) =>
    json?.error ?? "Relay request failed",
  RELAY_SESSION_COOKIE: "nodus_session",
}));

import { DELETE } from "../[entity_type]/[entity_id]/route";
import { POST as RESTORE } from "../[entity_type]/[entity_id]/restore/route";
function request(method: string, cookie = "nodus_session=abc"): Request {
  return new Request("http://localhost/api/tombstones", { method, headers: cookie ? { cookie } : {} });
}

const params = Promise.resolve({ entity_type: "file", entity_id: "f-1" });

beforeEach(() => vi.clearAllMocks());

describe("DELETE /api/tombstones/[entity_type]/[entity_id]", () => {
  it("rejects an anonymous purge before contacting the Relay", async () => {
    const response = await DELETE(request("DELETE", "") as never, { params });
    expect(response.status).toBe(401);
    expect(mockRelayFetch).not.toHaveBeenCalled();
  });

  it("proxies an authenticated purge with encoded segments", async () => {
    mockRelayFetch.mockResolvedValue({ status: 200, json: { status: "purged" }, setCookies: [] });
    const response = await DELETE(request("DELETE") as never, { params });
    expect(response.status).toBe(200);
    expect(mockRelayFetch).toHaveBeenCalledWith("/tombstones/file/f-1", { method: "DELETE" });
  });
});

describe("POST /api/tombstones/[entity_type]/[entity_id]/restore", () => {
  it("rejects an anonymous restore", async () => {
    const response = await RESTORE(request("POST", "") as never, { params });
    expect(response.status).toBe(401);
    expect(mockRelayFetch).not.toHaveBeenCalled();
  });

  it("proxies an authenticated restore", async () => {
    mockRelayFetch.mockResolvedValue({ status: 200, json: {}, setCookies: [] });
    const response = await RESTORE(request("POST") as never, { params });
    expect(response.status).toBe(200);
    expect(mockRelayFetch).toHaveBeenCalledWith("/tombstones/file/f-1/restore", { method: "POST" });
  });
});
