import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RelayWsClient, relayWsEndpoint } from "../src/ws-client";

describe("relayWsEndpoint", () => {
  it("converts http:// to ws://", () => {
    expect(relayWsEndpoint("http://localhost:8080")).toBe("ws://localhost:8080/ws");
  });

  it("converts https:// to wss://", () => {
    expect(relayWsEndpoint("https://relay.example.com")).toBe("wss://relay.example.com/ws");
  });

  it("appends /ws path if missing", () => {
    expect(relayWsEndpoint("http://localhost:8080")).toBe("ws://localhost:8080/ws");
    expect(relayWsEndpoint("http://localhost:8080/")).toBe("ws://localhost:8080/ws");
  });

  it("preserves existing /ws path", () => {
    expect(relayWsEndpoint("http://localhost:8080/ws")).toBe("ws://localhost:8080/ws");
    expect(relayWsEndpoint("http://localhost:8080/ws/")).toBe("ws://localhost:8080/ws");
  });

  it("strips trailing /ws before re-adding", () => {
    expect(relayWsEndpoint("http://localhost:8080/ws")).toBe("ws://localhost:8080/ws");
  });

  it("does not strip hostnames or paths that merely end in ws", () => {
    expect(relayWsEndpoint("https://relay-news")).toBe("wss://relay-news/ws");
    expect(relayWsEndpoint("https://relay.example.com/news")).toBe("wss://relay.example.com/news/ws");
  });

  it("handles ws:// input", () => {
    expect(relayWsEndpoint("ws://localhost:8080")).toBe("ws://localhost:8080/ws");
  });

  it("handles wss:// input", () => {
    expect(relayWsEndpoint("wss://localhost:8080")).toBe("wss://localhost:8080/ws");
  });
});

// Mock WebSocket for testing
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

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
  }

  send = vi.fn();

  close(code?: number, reason?: string) {
    this.closeCode = code ?? null;
    this.closeReason = reason ?? null;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: code ?? 1000, reason: reason ?? "" }));
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  simulateMessage(data: string) {
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

beforeEach(() => {
  vi.restoreAllMocks();
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

      // Simulate the WebSocket opening
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

      const envelope = {
        type: "heartbeat",
        payload: { id: "peer-1", timestamp: new Date().toISOString() },
        message_id: "msg-1",
        schema_version: "1.0",
        timestamp: new Date().toISOString(),
      };
      ws.simulateMessage(JSON.stringify(envelope));

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

    it("calls onClose on close", () => {
      const onClose = vi.fn();
      const client = new RelayWsClient("ws://localhost:8080/ws", { onClose });
      client.connect();

      const ws = (client as unknown as { ws: MockWebSocket }).ws;
      ws.simulateOpen();
      ws.simulateClose(1000, "normal");

      expect(onClose).toHaveBeenCalledWith(1000, "normal");
      expect(client.connected).toBe(false);
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

    it("throws if not connected", () => {
      const client = new RelayWsClient("ws://localhost:8080/ws");

      expect(() => client.send({ type: "test", payload: {} })).toThrow(
        "relay ws client is not connected",
      );
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
});
