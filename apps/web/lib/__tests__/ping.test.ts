import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageTypes } from "@repo/protocol";

import { pingDevice, pingNode } from "../ping";
import { setPresenceBridge } from "../presence-bridge";

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

describe("ping over the Relay socket", () => {
  afterEach(() => {
    setPresenceBridge(null);
    vi.restoreAllMocks();
  });

  it("uses the WS presence query when the socket is connected", async () => {
    let handler: ((payload: unknown) => void) | null = null;
    const sent: Array<{ type: string; payload: unknown }> = [];
    setPresenceBridge({
      isConnected: () => true,
      subscribe: (type, next) => {
        expect(type).toBe(MessageTypes.PRESENCE_RESULT);
        handler = next;
        return () => {
          handler = null;
        };
      },
      send: (message) => {
        sent.push(message);
        const { request_id } = message.payload as { request_id: string };
        // Answer on a later microtask, as the Relay would.
        queueMicrotask(() => handler?.({ request_id, online: true, rtt_ms: 7 }));
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await pingNode("node-1");

    expect(result).toEqual({ online: true, rttMs: 7 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: MessageTypes.PRESENCE_QUERY,
      payload: { peer_id: "node-1", kind: "node" },
    });
  });

  it("falls back to HTTP when the socket probe times out", async () => {
    vi.useFakeTimers();
    setPresenceBridge({
      isConnected: () => true,
      subscribe: () => () => {},
      send: () => {},
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ online: true, rtt_ms: 9 }));

    const promise = pingNode("node-1");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(promise).resolves.toEqual({ online: true, rttMs: 9 });
    expect(fetchSpy).toHaveBeenCalledWith("/api/nodes/node-1/ping", { method: "POST" });
    vi.useRealTimers();
  });
});
