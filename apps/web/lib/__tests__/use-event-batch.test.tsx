import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Capture the shared socket so two hook instances (two call sites) can be
// driven against the same send/on pair, which is how the real WsProvider works.
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const sent: unknown[] = [];

vi.mock("../../providers/ws-provider", () => ({
  useWs: () => ({
    send: (message: unknown) => sent.push(message),
    on: (type: string, callback: (payload: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(callback);
      listeners.set(type, set);
      return () => set.delete(callback);
    },
  }),
}));

import { useEventBatch } from "../use-event-batch";

function emitAck(payload: unknown) {
  for (const callback of listeners.get("batch_ack") ?? []) callback(payload);
}

const events = [{ type: "file_added", payload: {} }] as never;

beforeEach(() => {
  listeners.clear();
  sent.length = 0;
});

describe("useEventBatch", () => {
  it("serializes batches across separate hook instances", async () => {
    const a = renderHook(() => useEventBatch());
    const b = renderHook(() => useEventBatch());

    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    await act(async () => {
      first = a.result.current(events);
      second = b.result.current(events);
      // Let the shared queue advance one microtask so the first batch sends.
      await Promise.resolve();
    });

    // Only the first batch is in flight; the second waits on the shared queue.
    expect(sent).toHaveLength(1);

    const ackOne = { applied_event_ids: ["e1"], ok: true };
    await act(async () => {
      emitAck(ackOne);
    });
    await expect(first).resolves.toEqual(ackOne);

    // Now the queued batch leaves, and resolves against its own (later) ack.
    expect(sent).toHaveLength(2);
    const ackTwo = { applied_event_ids: ["e2"], ok: true };
    await act(async () => {
      emitAck(ackTwo);
    });
    await expect(second).resolves.toEqual(ackTwo);
  });
});
