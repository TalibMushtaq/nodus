import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { login, register, logout, fetchSession } from "../auth-client";
import type { StoredDeviceIdentity } from "@repo/relay-client";

const mockDevice: StoredDeviceIdentity = {
  device_id: "test-device-id",
  public_key: "test-public-key",
  private_key: "test-private-key",
};

const mockSession = {
  account_id: "acct-123",
  device_id: "dev-123",
  session_expires_at: new Date(Date.now() + 3600000).toISOString(),
};

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("login", () => {
  it("sends credentials to /api/auth/login", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockSession), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock;

    await login("test@example.com", "password123", mockDevice);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");

    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body.email).toBe("test@example.com");
    expect(body.password).toBe("password123");
    expect(body.device_id).toBe(mockDevice.device_id);
    expect(body.device_public_key).toBe(mockDevice.public_key);
  });

  it("returns session on success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockSession), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await login("test@example.com", "password123", mockDevice);

    expect(result.ok).toBe(true);
    expect(result.session).toEqual(mockSession);
    expect(result.error).toBeUndefined();
  });

  it("returns error on failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Invalid credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await login("test@example.com", "wrong-password", mockDevice);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Invalid credentials");
    expect(result.session).toBeUndefined();
  });
});

describe("register", () => {
  it("sends credentials to /api/auth/register", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockSession), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock;

    await register("test@example.com", "password123", mockDevice);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/register");
    expect(init.method).toBe("POST");

    const body = JSON.parse(String(init.body)) as Record<string, string>;
    expect(body.email).toBe("test@example.com");
    expect(body.password).toBe("password123");
    expect(body.device_id).toBe(mockDevice.device_id);
    expect(body.device_public_key).toBe(mockDevice.public_key);
  });

  it("returns session on success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockSession), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await register("test@example.com", "password123", mockDevice);

    expect(result.ok).toBe(true);
    expect(result.session).toEqual(mockSession);
  });

  it("returns error on conflict", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Email already exists" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await register("test@example.com", "password123", mockDevice);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Email already exists");
  });
});

describe("logout", () => {
  it("calls /api/auth/logout", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "logged out" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock;

    await logout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/logout");
    expect(init.method).toBe("POST");
  });
});

describe("fetchSession", () => {
  it("returns session when authenticated", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockSession), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const session = await fetchSession();

    expect(session).toEqual(mockSession);
  });

  it("returns null when unauthenticated", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const session = await fetchSession();

    expect(session).toBeNull();
  });

  it("returns null on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const session = await fetchSession();

    expect(session).toBeNull();
  });
});
