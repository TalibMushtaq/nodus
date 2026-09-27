import { describe, expect, it } from "vitest";

import { crossOriginFailure } from "../csrf";

function request(method: string, headers: Record<string, string>): Request {
  return new Request("https://nodus.example.com/api/devices", { method, headers });
}

describe("crossOriginFailure", () => {
  it("ignores read-only methods", () => {
    expect(crossOriginFailure(request("GET", {}))).toBeNull();
    expect(crossOriginFailure(request("HEAD", {}))).toBeNull();
  });

  it("rejects a cross-site request via Sec-Fetch-Site", () => {
    expect(
      crossOriginFailure(request("POST", { "sec-fetch-site": "cross-site" })),
    ).toMatchObject({ status: 403 });
  });

  it("allows a same-origin request", () => {
    expect(
      crossOriginFailure(
        request("POST", { origin: "https://nodus.example.com", host: "nodus.example.com" }),
      ),
    ).toBeNull();
  });

  it("rejects a mismatched Origin", () => {
    expect(
      crossOriginFailure(
        request("DELETE", { origin: "https://evil.example", host: "nodus.example.com" }),
      ),
    ).toMatchObject({ status: 403, error: "cross-origin request rejected" });
  });

  it("falls back to Referer when Origin is absent", () => {
    expect(
      crossOriginFailure(
        request("PATCH", {
          referer: "https://evil.example/page",
          host: "nodus.example.com",
        }),
      ),
    ).toMatchObject({ status: 403 });
  });

  it("allows non-browser callers with no Origin/Referer", () => {
    expect(crossOriginFailure(request("POST", { host: "nodus.example.com" }))).toBeNull();
  });

  it("rejects an unparseable Origin", () => {
    expect(
      crossOriginFailure(request("POST", { origin: "not a url", host: "nodus.example.com" })),
    ).toMatchObject({ status: 403, error: "invalid request origin" });
  });
});
