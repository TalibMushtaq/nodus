import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRelayFetch } = vi.hoisted(() => ({ mockRelayFetch: vi.fn() }));

vi.mock("../../../../../lib/relay", () => ({
  relayFetch: mockRelayFetch,
  relayErrorMessage: ({ json }: { json: { error?: string } | null }) =>
    json?.error ?? "Relay request failed",
}));

import { POST } from "../route";

const created = {
  code: "NODUS-ABCD-2345",
  expires_at: "2026-09-11T16:39:24.591713239Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/pairing/codes", () => {
  it("proxies to the Relay and returns the minted code", async () => {
    mockRelayFetch.mockResolvedValue({ status: 201, json: created, setCookie: null });

    const response = await POST(
      new Request("http://localhost/api/pairing/codes", { method: "POST" }) as never,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(created);
    expect(mockRelayFetch).toHaveBeenCalledWith("/pairing/codes", {
      method: "POST",
      body: "",
    });
  });

  it("maps a Relay failure to an { error } body with the same status", async () => {
    mockRelayFetch.mockResolvedValue({
      status: 401,
      json: { error: "unauthorized" },
      setCookie: null,
    });

    const response = await POST(
      new Request("http://localhost/api/pairing/codes", { method: "POST" }) as never,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("treats any 2xx as a successful mint", async () => {
    mockRelayFetch.mockResolvedValue({ status: 200, json: created, setCookie: null });

    const response = await POST(
      new Request("http://localhost/api/pairing/codes", { method: "POST" }) as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(created);
  });
});
