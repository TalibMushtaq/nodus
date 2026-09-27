import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRelayFetch } = vi.hoisted(() => ({ mockRelayFetch: vi.fn() }));

vi.mock("../../../../lib/relay", () => ({
  relayFetch: mockRelayFetch,
  relayErrorMessage: ({ json }: { json: { error?: string } | null }) =>
    json?.error ?? "Relay request failed",
  RELAY_SESSION_COOKIE: "nodus_session",
}));

import { DELETE, PATCH } from "../[id]/route";

function request(method: string, body: string, cookie = "nodus_session=abc") {
  return new Request("http://localhost/api/devices/dev-1", {
    method,
    body,
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /api/devices/[id]", () => {
  it("rejects an anonymous call before contacting the Relay", async () => {
    const response = await DELETE(request("DELETE", "", "") as never, {
      params: Promise.resolve({ id: "dev-1" }),
    });
    expect(response.status).toBe(401);
    expect(mockRelayFetch).not.toHaveBeenCalled();
  });

  it("proxies an authenticated revoke", async () => {
    mockRelayFetch.mockResolvedValue({ status: 200, json: { status: "revoked" }, setCookie: null });
    const response = await DELETE(request("DELETE", "") as never, {
      params: Promise.resolve({ id: "dev-1" }),
    });
    expect(response.status).toBe(200);
    expect(mockRelayFetch).toHaveBeenCalledWith("/devices/dev-1", { method: "DELETE" });
  });
});

describe("PATCH /api/devices/[id]", () => {
  it("rejects anonymous and malformed-name calls", async () => {
    const anonymous = await PATCH(request("PATCH", '{"name":"Desk"}', "") as never, {
      params: Promise.resolve({ id: "dev-1" }),
    });
    expect(anonymous.status).toBe(401);

    const badName = await PATCH(request("PATCH", '{"name":42}') as never, {
      params: Promise.resolve({ id: "dev-1" }),
    });
    expect(badName.status).toBe(400);
    expect(mockRelayFetch).not.toHaveBeenCalled();
  });

  it("forwards a sanitized name", async () => {
    mockRelayFetch.mockResolvedValue({ status: 200, json: { display_name: "Desk" }, setCookie: null });
    const response = await PATCH(request("PATCH", '{"name":"  Desk  "}') as never, {
      params: Promise.resolve({ id: "dev-1" }),
    });
    expect(response.status).toBe(200);
    expect(mockRelayFetch).toHaveBeenCalledWith("/devices/dev-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Desk" }),
    });
  });
});
