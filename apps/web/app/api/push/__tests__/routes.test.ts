import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRelayFetch } = vi.hoisted(() => ({ mockRelayFetch: vi.fn() }));

vi.mock("../../../../lib/relay", () => ({
  relayFetch: mockRelayFetch,
  relayErrorMessage: ({ json }: { json: { error?: string } | null }) =>
    json?.error ?? "Relay request failed",
  RELAY_SESSION_COOKIE: "nodus_session",
}));

import { POST } from "../subscribe/route";
import { DELETE } from "../unsubscribe/route";

const subscription = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };

function request(method: string, body: string, cookie = "nodus_session=abc"): Request {
  return new Request("http://localhost/api/push", {
    method,
    body,
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/push/subscribe", () => {
  it("rejects an anonymous call before contacting the Relay", async () => {
    const response = await POST(request("POST", JSON.stringify(subscription), "") as never);
    expect(response.status).toBe(401);
    expect(mockRelayFetch).not.toHaveBeenCalled();
  });

  it("rejects a malformed subscription", async () => {
    const response = await POST(request("POST", JSON.stringify({ endpoint: 1 })) as never);
    expect(response.status).toBe(400);
    expect(mockRelayFetch).not.toHaveBeenCalled();
  });

  it("forwards a valid subscription", async () => {
    mockRelayFetch.mockResolvedValue({ status: 200, json: { status: "ok" }, setCookies: [] });
    const response = await POST(request("POST", JSON.stringify(subscription)) as never);
    expect(response.status).toBe(200);
    expect(mockRelayFetch).toHaveBeenCalledWith("/devices/web-push", {
      method: "POST",
      body: JSON.stringify(subscription),
    });
  });
});

describe("DELETE /api/push/unsubscribe", () => {
  it("rejects an anonymous call", async () => {
    const response = await DELETE(request("DELETE", JSON.stringify({ endpoint: "x" }), "") as never);
    expect(response.status).toBe(401);
  });

  it("rejects a body with no endpoint", async () => {
    const response = await DELETE(request("DELETE", "{}") as never);
    expect(response.status).toBe(400);
    expect(mockRelayFetch).not.toHaveBeenCalled();
  });

  it("forwards the endpoint", async () => {
    mockRelayFetch.mockResolvedValue({ status: 200, json: { status: "ok" }, setCookies: [] });
    const response = await DELETE(request("DELETE", JSON.stringify({ endpoint: "x" })) as never);
    expect(response.status).toBe(200);
    expect(mockRelayFetch).toHaveBeenCalledWith("/devices/web-push", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: "x" }),
    });
  });
});
