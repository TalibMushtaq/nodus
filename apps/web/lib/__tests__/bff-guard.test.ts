import { describe, expect, it } from "vitest";

import { requireSession } from "../bff-guard";

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/test", { method: "POST", headers });
}

describe("requireSession", () => {
  it("allows a request that carries the session cookie", () => {
    expect(requireSession(request({ cookie: "nodus_session=abc" }))).toBeNull();
  });

  it("finds the session cookie among others", () => {
    expect(requireSession(request({ cookie: "theme=dark; nodus_session=abc; x=1" }))).toBeNull();
  });

  it("rejects a request with no cookie", () => {
    const response = requireSession(request());
    expect(response?.status).toBe(401);
  });

  it("rejects a request with an unrelated cookie only", () => {
    expect(requireSession(request({ cookie: "theme=dark" }))?.status).toBe(401);
  });
});
