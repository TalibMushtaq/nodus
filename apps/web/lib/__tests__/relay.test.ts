import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCookies } = vi.hoisted(() => ({ mockCookies: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: mockCookies }));

import { relayFetch, publicRelayUrl } from "../relay";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockCookies.mockResolvedValue({
    get: (name: string) => name === "nodus_session" ? { value: "session-from-browser" } : undefined,
  });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("relayFetch", () => {
  it("forwards the browser session cookie to the Relay", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ account_id: "acct-123" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock;

    await relayFetch("/auth/session");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/auth/session",
      expect.anything(),
    );
    expect(new Headers(init.headers).get("cookie")).toBe("nodus_session=session-from-browser");
  });

  it("returns the Relay Set-Cookie header for auth routes to forward", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ account_id: "acct-123" }), {
        status: 200,
        headers: { "set-cookie": "nodus_session=new-session; HttpOnly; Path=/" },
      }),
    );

    const result = await relayFetch("/auth/login", { method: "POST" });

    expect(result.setCookie).toBe("nodus_session=new-session; HttpOnly; Path=/");
  });
});

describe("publicRelayUrl", () => {
  const ORIGINAL = process.env.PUBLIC_RELAY_URL;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PUBLIC_RELAY_URL;
    else process.env.PUBLIC_RELAY_URL = ORIGINAL;
  });

  it("returns the trimmed operator-configured value", () => {
    process.env.PUBLIC_RELAY_URL = "  https://nodus.example.com  ";
    expect(publicRelayUrl()).toBe("https://nodus.example.com");
  });

  it("returns null when unset or blank (never the internal relayUrl)", () => {
    delete process.env.PUBLIC_RELAY_URL;
    expect(publicRelayUrl()).toBeNull();
    process.env.PUBLIC_RELAY_URL = "   ";
    expect(publicRelayUrl()).toBeNull();
  });
});
