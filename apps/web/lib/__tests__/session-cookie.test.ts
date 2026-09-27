import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { hardenSessionCookie, requestHasSessionCookie } from "../session-cookie";

describe("hardenSessionCookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds HttpOnly and SameSite=Lax when absent", () => {
    expect(hardenSessionCookie("nodus_session=abc; Path=/")).toBe(
      "nodus_session=abc; Path=/; HttpOnly; SameSite=Lax",
    );
  });

  it("does not duplicate attributes the Relay already set", () => {
    expect(hardenSessionCookie("nodus_session=abc; HttpOnly; SameSite=Strict; Path=/")).toBe(
      "nodus_session=abc; HttpOnly; SameSite=Strict; Path=/",
    );
  });

  it("only adds Secure in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(hardenSessionCookie("nodus_session=abc; Path=/")).toContain("Secure");
    vi.stubEnv("NODE_ENV", "test");
    expect(hardenSessionCookie("nodus_session=abc; Path=/")).not.toContain("Secure");
  });
});

describe("requestHasSessionCookie", () => {
  it("detects the cookie among others", () => {
    const request = new Request("http://localhost/api/devices/x", {
      method: "DELETE",
      headers: { cookie: "theme=dark; nodus_session=abc; other=1" },
    });
    expect(requestHasSessionCookie(request)).toBe(true);
  });

  it("returns false when absent", () => {
    const request = new Request("http://localhost/api/devices/x", { method: "DELETE" });
    expect(requestHasSessionCookie(request)).toBe(false);
  });
});
