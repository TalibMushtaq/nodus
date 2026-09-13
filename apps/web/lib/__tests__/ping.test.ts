import { afterEach, describe, expect, it, vi } from "vitest";

import { pingDevice, pingNode } from "../ping";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ping helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to the node ping route and maps rtt_ms to rttMs", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ online: true, rtt_ms: 12 }));
    const result = await pingNode("node-1");
    expect(result).toEqual({ online: true, rttMs: 12 });
    expect(fetchSpy).toHaveBeenCalledWith("/api/nodes/node-1/ping", { method: "POST" });
  });

  it("posts to the device ping route and passes through an offline reason", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ online: false, reason: "timeout" }),
    );
    expect(await pingDevice("device-1")).toEqual({ online: false, reason: "timeout" });
  });

  it("surfaces the relay error on a non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "peer not found" }, 404));
    await expect(pingNode("node-1")).rejects.toThrow("peer not found");
  });
});
