import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionInfo } from "../session";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

// Mock ./relay
vi.mock("../relay", () => ({
  relayFetch: vi.fn(),
}));

import { getSession, requireAuth } from "../session";
import { relayFetch } from "../relay";
import { redirect } from "next/navigation";

const mockRelayFetch = vi.mocked(relayFetch);
const mockRedirect = vi.mocked(redirect);

const mockSession: SessionInfo = {
  account_id: "acct-123",
  device_id: "dev-123",
  session_expires_at: new Date(Date.now() + 3600000).toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getSession", () => {
  it("returns session when Relay returns 200", async () => {
    mockRelayFetch.mockResolvedValue({
      status: 200,
      json: mockSession,
      setCookie: null,
    });

    const session = await getSession();

    expect(session).toEqual(mockSession);
    expect(mockRelayFetch).toHaveBeenCalledWith("/auth/session");
  });

  it("returns null when Relay returns 401", async () => {
    mockRelayFetch.mockResolvedValue({
      status: 401,
      json: { error: "unauthorized" },
      setCookie: null,
    });

    const session = await getSession();

    expect(session).toBeNull();
  });

  it("returns null when Relay returns null json", async () => {
    mockRelayFetch.mockResolvedValue({
      status: 200,
      json: null,
      setCookie: null,
    });

    const session = await getSession();

    expect(session).toBeNull();
  });
});

describe("requireAuth", () => {
  it("returns session when authenticated", async () => {
    mockRelayFetch.mockResolvedValue({
      status: 200,
      json: mockSession,
      setCookie: null,
    });

    const session = await requireAuth();

    expect(session).toEqual(mockSession);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("redirects to /auth when unauthenticated", async () => {
    mockRelayFetch.mockResolvedValue({
      status: 401,
      json: null,
      setCookie: null,
    });

    await requireAuth();

    expect(mockRedirect).toHaveBeenCalledWith("/auth");
  });

  it("redirects to /auth when session is null", async () => {
    mockRelayFetch.mockResolvedValue({
      status: 200,
      json: null,
      setCookie: null,
    });

    await requireAuth();

    expect(mockRedirect).toHaveBeenCalledWith("/auth");
  });
});
