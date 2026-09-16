import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRelayFetch } = vi.hoisted(() => ({ mockRelayFetch: vi.fn() }));

vi.mock("../../../../lib/relay", () => ({
  relayFetch: mockRelayFetch,
  relayErrorMessage: ({ json }: { json: { error?: string } | null }) => json?.error ?? "Relay request failed",
}));

import { POST as login } from "../login/route";
import { POST as register } from "../register/route";
import { POST as logout } from "../logout/route";
import { POST as changePassword } from "../password/route";
import { POST as logoutAll } from "../logout-all/route";

const session = {
  account_id: "acct-123",
  device_id: "device-123",
  session_expires_at: "2026-09-10T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("auth route cookie forwarding", () => {
  it.each([
    ["login", login, 200, "nodus_session=login-session; HttpOnly; Path=/"],
    ["register", register, 201, "nodus_session=register-session; HttpOnly; Path=/"],
    ["logout", logout, 200, "nodus_session=; Max-Age=0; HttpOnly; Path=/"],
    ["password", changePassword, 200, "nodus_session=rotated-session; HttpOnly; Path=/"],
    ["logout-all", logoutAll, 200, "nodus_session=reissued-session; HttpOnly; Path=/"],
  ] as const)("forwards the Relay Set-Cookie header on %s", async (_name, handler, status, setCookie) => {
    mockRelayFetch.mockResolvedValue({
      status,
      json: handler === logout ? { status: "logged out" } : session,
      setCookie,
    });

    const response = await handler(new Request("http://localhost/api/auth", { method: "POST" }) as never);

    expect(response.status).toBe(status);
    expect(response.headers.get("set-cookie")).toBe(setCookie);
  });

  it("surfaces the Relay error body on a rejected password change", async () => {
    mockRelayFetch.mockResolvedValue({
      status: 401,
      json: { error: "current password is incorrect" },
      setCookie: null,
    });

    const response = await changePassword(
      new Request("http://localhost/api/auth/password", { method: "POST", body: "{}" }) as never,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "current password is incorrect" });
  });
});
