import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRelayFetch } = vi.hoisted(() => ({ mockRelayFetch: vi.fn() }));

vi.mock("../../../../../lib/relay", () => ({
  relayFetch: mockRelayFetch,
  relayErrorMessage: ({ json }: { json: { error?: string } | null }) =>
    json?.error ?? "Relay request failed",
  RELAY_SESSION_COOKIE: "nodus_session",
}));

import { POST } from "../route";

function request(body: string, cookie = "nodus_session=abc"): Request {
  return new Request("http://localhost/api/pairing/sessions", {
    method: "POST",
    body,
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/pairing/sessions", () => {
  it("rejects an anonymous call before contacting the Relay", async () => {
    const response = await POST(request("{}", "") as never);
    expect(response.status).toBe(401);
    expect(mockRelayFetch).not.toHaveBeenCalled();
  });

  it("rejects a non-object body", async () => {
    const response = await POST(request("[1,2]") as never);
    expect(response.status).toBe(400);
    expect(mockRelayFetch).not.toHaveBeenCalled();
  });

  it("proxies an authenticated session request", async () => {
    mockRelayFetch.mockResolvedValue({ status: 201, json: { token: "t" }, setCookies: [] });
    const response = await POST(request('{"node_id":"n1"}') as never);
    expect(response.status).toBe(201);
    expect(mockRelayFetch).toHaveBeenCalledWith("/pairing/sessions", {
      method: "POST",
      body: JSON.stringify({ node_id: "n1" }),
    });
  });
});
