import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  afterEach as fakeAfterEach,
  beforeEach as fakeBeforeEach,
} from "vitest";
import {
  RelayWsClient,
  relayWsEndpoint,
  CLOSE_CODE_UNAUTHORIZED,
} from "../src/ws-client";

describe("relayWsEndpoint", () => {
  it("converts http:// to ws://", () => {
    expect(relayWsEndpoint("http://localhost:8080")).toBe(
      "ws://localhost:8080/ws",
    );
  });

  it("converts https:// to wss://", () => {
    expect(relayWsEndpoint("https://relay.example.com")).toBe(
      "wss://relay.example.com/ws",
    );
  });

  it("appends /ws path if missing", () => {
    expect(relayWsEndpoint("http://localhost:8080")).toBe(
      "ws://localhost:8080/ws",
    );
    expect(relayWsEndpoint("http://localhost:8080/")).toBe(
      "ws://localhost:8080/ws",
    );
  });

  it("preserves existing /ws path", () => {
    expect(relayWsEndpoint("http://localhost:8080/ws")).toBe(
      "ws://localhost:8080/ws",
    );
    expect(relayWsEndpoint("http://localhost:8080/ws/")).toBe(
      "ws://localhost:8080/ws",
    );
  });

  it("strips trailing /ws before re-adding", () => {
    expect(relayWsEndpoint("http://localhost:8080/ws")).toBe(
      "ws://localhost:8080/ws",
    );
  });

  it("does not strip hostnames or paths that merely end in ws", () => {
    expect(relayWsEndpoint("https://relay-news")).toBe("wss://relay-news/ws");
    expect(relayWsEndpoint("https://relay.example.com/news")).toBe(
      "wss://relay.example.com/news/ws",
    );
  });

  it("handles ws:// input", () => {
    expect(relayWsEndpoint("ws://localhost:8080")).toBe(
      "ws://localhost:8080/ws",
    );
  });

  it("handles wss:// input", () => {
    expect(relayWsEndpoint("wss://localhost:8080")).toBe(
      "wss://localhost:8080/ws",
    );
  });
});

// Mock WebSocket for testing
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  // Tracks every constructed instance so reconnection tests can assert that a
  // fresh socket (not a reused one) was opened.
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  private closeCode: number | null = null;
  private closeReason: string | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send = vi.fn();

  close = vi.fn((code?: number, reason?: string) => {
    this.closeCode = code ?? null;
    this.closeReason = reason ?? null;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(
      new CloseEvent("close", { code: code ?? 1000, reason: reason ?? "" }),
    );
  });

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  simulateError() {
    this.onerror?.(new Event("error"));
  }

  simulateClose(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

const ORIGINAL_WEBSOCKET = globalThis.WebSocket;

function lastSocket(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

function socketCount(): number {
  return MockWebSocket.instances.length;
}

function heartbeatEnvelope(payload: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "heartbeat",
    payload: { id: "peer-1", timestamp: new Date().toISOString(), ...payload },
    message_id: "msg-1",
    schema_version: "1.0",
    timestamp: new Date().toISOString(),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  MockWebSocket.instances = [];
  // @ts-expect-error - mocking WebSocket for tests
  globalThis.WebSocket = MockWebSocket;
});

afterEach(() => {
  globalThis.WebSocket = ORIGINAL_WEBSOCKET;
});

describe("RelayWsClient", () => {
  describe("connect", () => {
    it("opens WebSocket to endpoint", () => {
      const client = new RelayWsClient("ws://localhost:8080/ws");
      client.connect();

      // WebSocket should be created (MockWebSocket tracks the URL)
      expect(client.connected).toBe(false); // Not yet open
    });

    it("does NOT include token in URL", () => {
      const client = new RelayWsClient("ws://localhost:8080/ws");
      client.connect();

      const ws = (client as unknown as { ws: MockWebSocket }).ws;
      expect(ws.url).toBe("ws://localhost:8080/ws");
      expect(ws.url).not.toContain("?token=");
    });

    it("calls onOpen handler", () => {
      const onOpen = vi.fn();
      const client = new RelayWsClient("ws://localhost:8080/ws", { onOpen });
      client.connect();

      const ws = (client as unknown as { ws: MockWebSocket }).ws;
      ws.simulateOpen();

      expect(onOpen).toHaveBeenCalled();
      expect(client.connected).toBe(true);
    });

    it("calls onMessage with parsed envelope", () => {
      const onMessage = vi.fn();
      const client = new RelayWsClient("ws://localhost:8080/ws", { onMessage });
      client.connect();

      const ws = (client as unknown as { ws: MockWebSocket }).ws;
      ws.simulateOpen();
      ws.simulateMessage(heartbeatEnvelope());

      expect(onMessage).toHaveBeenCalled();
      const result = onMessage.mock.calls[0][0];
      expect(result.ok).toBe(true);
    });

    it("calls onError on non-JSON frame", () => {
      const onError = vi.fn();
      const client = new RelayWsClient("ws://localhost:8080/ws", { onError });
      client.connect();

      const ws = (client as unknown as { ws: MockWebSocket }).ws;
      ws.simulateOpen();
      ws.simulateMessage("not-valid-json");

      expect(onError).toHaveBeenCalled();
      expect(onError.mock.calls[0][0].message).toContain("non-JSON");
    });

    it("closes on a non-text frame without coercing it to JSON", () => {
      const onError = vi.fn();
      const client = new RelayWsClient("ws://localhost:8080/ws", { onError });
      client.connect();
      const ws = (client as unknown as { ws: MockWebSocket }).ws;
      ws.simulateOpen();
      ws.simulateMessage(new ArrayBuffer(4));

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect((onError.mock.calls[0]![0] as Error).message).toContain(
        "non-text",
      );
      expect(ws.close).toHaveBeenCalledWith(1003, "non-text relay frame");
    });

    it("calls onClose on close", () => {
      const onClose = vi.fn();
      const client = new RelayWsClient("ws://localhost:8080/ws", { onClose });
      client.connect();

      const ws = (client as unknown as { ws: MockWebSocket }).ws;
      ws.simulateOpen();
      ws.simulateClose(1000, "normal");

      expect(onClose).toHaveBeenCalledWith(1000, "normal");
      expect(client.connected).toBe(false);

      // An unexpected (non-explicit) close schedules a reconnect; cancel it so
      // the pending timer doesn't leak into later tests.
      client.close();
    });
  });

  describe("send", () => {
    it("builds envelope with schema version", () => {
      const client = new RelayWsClient("ws://localhost:8080/ws");
      client.connect();

      const ws = (client as unknown as { ws: MockWebSocket }).ws;
      ws.simulateOpen();

      client.send({ type: "heartbeat", payload: { id: "peer-1" } });

      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe("heartbeat");
      expect(sent.schema_version).toBeDefined();
      expect(sent.message_id).toBeDefined();
      expect(sent.timestamp).toBeDefined();
      expect(sent.payload).toEqual({ id: "peer-1" });
    });

    it("is a no-op if not connected", () => {
      const client = new RelayWsClient("ws://localhost:8080/ws");
      expect(() => client.send({ type: "test", payload: {} })).not.toThrow();
    });
  });

  describe("heartbeat", () => {
    it("sends heartbeat message with peer id", () => {
      const client = new RelayWsClient("ws://localhost:8080/ws");
      client.connect();

      const ws = (client as unknown as { ws: MockWebSocket }).ws;
      ws.simulateOpen();

      client.heartbeat("peer-123");

      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe("heartbeat");
      expect(sent.payload).toEqual({ id: "peer-123" });
    });
  });

  describe("close", () => {
    it("closes WebSocket connection", () => {
      const onClose = vi.fn();
      const client = new RelayWsClient("ws://localhost:8080/ws", { onClose });
      client.connect();

      const ws = (client as unknown as { ws: MockWebSocket }).ws;
      ws.simulateOpen();

      client.close();

      expect(client.connected).toBe(false);
      expect(onClose).toHaveBeenCalled();
    });

    it("sets ws to null", () => {
      const client = new RelayWsClient("ws://localhost:8080/ws");
      client.connect();

      const ws = (client as unknown as { ws: MockWebSocket }).ws;
      ws.simulateOpen();

      client.close();

      expect((client as unknown as { ws: unknown }).ws).toBeNull();
    });
  });

  describe("connected", () => {
    it("returns false when not connected", () => {
      const client = new RelayWsClient("ws://localhost:8080/ws");
      expect(client.connected).toBe(false);
    });

    it("returns true when WebSocket is open", () => {
      const client = new RelayWsClient("ws://localhost:8080/ws");
      client.connect();

      const ws = (client as unknown as { ws: MockWebSocket }).ws;
      ws.simulateOpen();

      expect(client.connected).toBe(true);
    });

    it("returns false after close", () => {
      const client = new RelayWsClient("ws://localhost:8080/ws");
      client.connect();

      const ws = (client as unknown as { ws: MockWebSocket }).ws;
      ws.simulateOpen();
      client.close();

      expect(client.connected).toBe(false);
    });
  });

  describe("connection state machine", () => {
    it("starts disconnected and reports transitions", () => {
      const states: string[] = [];
      const client = new RelayWsClient({
        endpoint: "ws://localhost:8080/ws",
        peerId: "peer-1",
        handlers: { onStateChange: (s) => states.push(s) },
      });

      expect(client.connectionState).toBe("disconnected");

      client.connect();
      expect(client.connectionState).toBe("connecting");

      lastSocket().simulateOpen();
      expect(client.connectionState).toBe("connected");

      client.close();
      expect(client.connectionState).toBe("disconnected");

      expect(states).toEqual(["connecting", "connected", "disconnected"]);
    });
  });

  describe("socket identity", () => {
    it("ignores close and open callbacks from a stale socket", () => {
      const onClose = vi.fn();
      const client = new RelayWsClient("ws://localhost:8080/ws", { onClose });
      client.connect();
      const first = lastSocket();

      client.close();
      client.connect();
      const second = lastSocket();
      second.simulateOpen();
      first.simulateOpen();
      first.simulateClose(1006, "stale");

      expect(client.connectionState).toBe("connected");
      expect(client.connected).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1); // the explicit first close only
      client.close();
    });
  });

  describe("reconnection", () => {
    fakeBeforeEach(() => vi.useFakeTimers());
    fakeAfterEach(() => vi.useRealTimers());

    it("schedules a reconnect with backoff after an unexpected close", () => {
      const states: string[] = [];
      const client = new RelayWsClient({
        endpoint: "ws://localhost:8080/ws",
        peerId: "peer-1",
        reconnect: { maxRetries: 5, baseDelay: 1, maxDelay: 10 },
        handlers: { onStateChange: (s) => states.push(s) },
      });
      client.connect();
      lastSocket().simulateOpen();

      lastSocket().simulateClose(1006, "network blip");
      expect(client.connectionState).toBe("reconnecting");
      expect(socketCount()).toBe(1); // no reconnect yet

      // Backoff for attempt 0 is base*1 + jitter, capped at 10ms — advance past
      // the max possible jitter to fire deterministically regardless of the
      // random() component.
      vi.advanceTimersByTime(3);

      expect(socketCount()).toBe(2);
      expect(client.connectionState).toBe("connecting");
      expect(states).toEqual([
        "connecting",
        "connected",
        "reconnecting",
        "connecting",
      ]);

      client.close();
    });

    it("resets the attempt counter on a successful reconnect", () => {
      const client = new RelayWsClient({
        endpoint: "ws://localhost:8080/ws",
        peerId: "peer-1",
        reconnect: { maxRetries: 5, baseDelay: 1, maxDelay: 10 },
      });
      client.connect();
      lastSocket().simulateOpen();

      // First unexpected close → attempt 0.
      lastSocket().simulateClose(1006);
      vi.advanceTimersByTime(3);
      expect(socketCount()).toBe(2);

      // Reconnect succeeds → attempt counter resets.
      lastSocket().simulateOpen();
      expect(client.connectionState).toBe("connected");

      // Second unexpected close behaves like a first attempt again (this would
      // be attempt 1 with no reset, and with 5 retries it's never exhausted —
      // assert the state machine re-enters reconnecting rather than terminally
      // giving up).
      lastSocket().simulateClose(1006);
      expect(client.connectionState).toBe("reconnecting");
      vi.advanceTimersByTime(3);
      expect(socketCount()).toBe(3);

      client.close();
    });

    it("lands in disconnected_max_retries after exhausting the budget", () => {
      const states: string[] = [];
      const client = new RelayWsClient({
        endpoint: "ws://localhost:8080/ws",
        peerId: "peer-1",
        reconnect: { maxRetries: 2, baseDelay: 1, maxDelay: 10 },
        handlers: { onStateChange: (s) => states.push(s) },
      });
      client.connect();
      lastSocket().simulateOpen();

      for (let i = 0; i < 3; i++) {
        lastSocket().simulateClose(1006);
        if (client.connectionState !== "disconnected_max_retries") {
          vi.advanceTimersByTime(5);
        }
      }

      expect(client.connectionState).toBe("disconnected_max_retries");
      expect(states).toContain("disconnected_max_retries");

      // No further self-retry after the terminal state.
      const countAfterExhaust = socketCount();
      vi.advanceTimersByTime(10_000);
      expect(socketCount()).toBe(countAfterExhaust);
      expect(client.connectionState).toBe("disconnected_max_retries");

      // An explicit connect() restarts the attempt cycle.
      client.connect();
      expect(client.connectionState).toBe("connecting");
      expect(socketCount()).toBe(countAfterExhaust + 1);
      client.close();
    });
  });

  describe("auth rejection", () => {
    fakeBeforeEach(() => vi.useFakeTimers());
    fakeAfterEach(() => vi.useRealTimers());

    it("does not retry and surfaces the auth error through onAuthError", () => {
      const onAuthError = vi.fn();
      const onClose = vi.fn();
      const states: string[] = [];
      const client = new RelayWsClient({
        endpoint: "ws://localhost:8080/ws",
        peerId: "peer-1",
        handlers: {
          onStateChange: (s) => states.push(s),
          onAuthError,
          onClose,
        },
      });
      client.connect();
      lastSocket().simulateOpen();

      lastSocket().simulateClose(CLOSE_CODE_UNAUTHORIZED, "unauthorized");

      expect(onAuthError).toHaveBeenCalledWith(
        CLOSE_CODE_UNAUTHORIZED,
        "unauthorized",
      );
      expect(onClose).toHaveBeenCalledWith(
        CLOSE_CODE_UNAUTHORIZED,
        "unauthorized",
      );
      expect(client.connectionState).toBe("disconnected_max_retries");

      // Auth rejection must never enter the reconnect loop.
      const countAfterReject = socketCount();
      vi.advanceTimersByTime(10_000);
      expect(socketCount()).toBe(countAfterReject);
      expect(client.connectionState).toBe("disconnected_max_retries");
      expect(states).toEqual([
        "connecting",
        "connected",
        "disconnected_max_retries",
      ]);
    });
  });

  describe("heartbeat loop", () => {
    fakeBeforeEach(() => vi.useFakeTimers());
    fakeAfterEach(() => vi.useRealTimers());

    it("sends presence immediately on connect, then on the heartbeat interval", () => {
      const client = new RelayWsClient({
        endpoint: "ws://localhost:8080/ws",
        peerId: "peer-1",
        heartbeat: { intervalMs: 1000 },
      });
      client.connect();
      lastSocket().simulateOpen();

      // Immediate presence announcement on connect.
      expect(lastSocket().send).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1000);
      expect(lastSocket().send).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(2000);
      expect(lastSocket().send).toHaveBeenCalledTimes(4);

      const sent = JSON.parse(
        lastSocket().send.mock.calls[
          lastSocket().send.mock.calls.length - 1
        ][0],
      );
      expect(sent.type).toBe("heartbeat");
      expect(sent.payload).toEqual({ id: "peer-1" });

      client.close();
    });

    it("sends no automatic heartbeats for legacy clients without a peerId", () => {
      const client = new RelayWsClient("ws://localhost:8080/ws");
      client.connect();
      lastSocket().simulateOpen();

      expect(lastSocket().send).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30_000);
      expect(lastSocket().send).not.toHaveBeenCalled();

      client.close();
    });

    it("treats a failing heartbeat as a dead connection and reconnects", () => {
      const client = new RelayWsClient({
        endpoint: "ws://localhost:8080/ws",
        peerId: "peer-1",
        heartbeat: { intervalMs: 1000 },
        reconnect: { maxRetries: 5, baseDelay: 1, maxDelay: 10 },
      });
      client.connect();
      lastSocket().simulateOpen();

      // From here on, sends fail as if the socket had silently died.
      lastSocket().send.mockImplementation(() => {
        throw new Error("socket dead");
      });

      vi.advanceTimersByTime(1000);

      expect(client.connectionState).toBe("reconnecting");

      client.close();
    });
  });

  describe("presence", () => {
    it("announces this client's presence on connect", () => {
      const client = new RelayWsClient({
        endpoint: "ws://localhost:8080/ws",
        peerId: "device-42",
      });
      client.connect();
      lastSocket().simulateOpen();

      expect(lastSocket().send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(lastSocket().send.mock.calls[0][0]);
      expect(sent.type).toBe("heartbeat");
      expect(sent.payload).toEqual({ id: "device-42" });

      client.close();
    });
  });

  describe("subscriptions", () => {
    it("dispatches envelopes to type-specific handlers and legacy onMessage", () => {
      const onMessage = vi.fn();
      const handler = vi.fn();
      const client = new RelayWsClient("ws://localhost:8080/ws", { onMessage });
      client.connect();
      lastSocket().simulateOpen();

      const unsubscribe = client.on("heartbeat", handler);
      lastSocket().simulateMessage(heartbeatEnvelope({ id: "peer-9" }));

      expect(handler).toHaveBeenCalledTimes(1);
      expect((handler.mock.calls[0][0] as { id: string }).id).toBe("peer-9");
      expect(onMessage).toHaveBeenCalled(); // backward compat preserved

      unsubscribe();
      lastSocket().simulateMessage(heartbeatEnvelope({ id: "peer-10" }));
      expect(handler).toHaveBeenCalledTimes(1); // not called again
    });

    it("supports multiple handlers and explicit off()", () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      const client = new RelayWsClient("ws://localhost:8080/ws");
      client.connect();
      lastSocket().simulateOpen();

      client.on("heartbeat", h1);
      client.on("heartbeat", h2);

      lastSocket().simulateMessage(heartbeatEnvelope({ id: "a" }));
      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);

      client.off("heartbeat", h1);
      lastSocket().simulateMessage(heartbeatEnvelope({ id: "b" }));
      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(2);

      client.close();
    });
  });

  describe("close idempotency", () => {
    fakeBeforeEach(() => vi.useFakeTimers());
    fakeAfterEach(() => vi.useRealTimers());

    it("is safe to call on a never-opened or already-closed client", () => {
      const client = new RelayWsClient("ws://localhost:8080/ws");
      expect(() => client.close()).not.toThrow();
      expect(() => client.close()).not.toThrow();
      expect(client.connectionState).toBe("disconnected");
    });

    it("cancels a pending reconnect instead of connecting again", () => {
      const client = new RelayWsClient({
        endpoint: "ws://localhost:8080/ws",
        peerId: "peer-1",
        reconnect: { maxRetries: 5, baseDelay: 1, maxDelay: 10 },
      });
      client.connect();
      lastSocket().simulateOpen();
      lastSocket().simulateClose(1006);

      expect(client.connectionState).toBe("reconnecting");

      client.close();
      expect(client.connectionState).toBe("disconnected");

      vi.advanceTimersByTime(10_000);
      expect(socketCount()).toBe(1); // no reconnect socket created
    });
  });
});
