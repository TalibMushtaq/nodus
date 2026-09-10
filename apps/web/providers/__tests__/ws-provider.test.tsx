import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { WsProvider, useWs } from "../ws-provider";

const { MockRelayWsClient, connect, close, on, send } = vi.hoisted(() => {
  const connect = vi.fn();
  const close = vi.fn();
  const on = vi.fn(() => () => {});
  const send = vi.fn();

  class MockRelayWsClient {
    static instances: MockRelayWsClient[] = [];
    options: {
      endpoint: string;
      peerId: string;
      handlers?: {
        onStateChange?: (state: string) => void;
        onAuthError?: (code: number, reason: string) => void;
      };
    };
    connect = connect;
    close = close;
    on = on;
    send = send;

    constructor(options: MockRelayWsClient["options"]) {
      this.options = options;
      MockRelayWsClient.instances.push(this);
    }
  }

  return { MockRelayWsClient, connect, close, on, send };
});

vi.mock("@repo/relay-client", () => ({
  RelayWsClient: MockRelayWsClient,
  relayWsEndpoint: (baseUrl: string) => `${baseUrl}/ws`,
}));

vi.mock("../auth-provider", () => ({
  useAuth: () => ({
    // Single stable identity; the provider derives its peerId from this.
    device: { device_id: "test-device-id" },
  }),
}));

function StatusProbe() {
  const { status } = useWs();
  return <span data-testid="status">{status}</span>;
}

function renderWithProvider() {
  return render(<StatusProbe />, { wrapper: WsProvider });
}

beforeEach(() => {
  vi.clearAllMocks();
  MockRelayWsClient.instances = [];
});

describe("WsProvider", () => {
  it("constructs a client with the device peerId and connects", async () => {
    await act(async () => {
      renderWithProvider();
    });

    expect(MockRelayWsClient.instances).toHaveLength(1);
    const instance = MockRelayWsClient.instances[0]!;
    expect(instance.options.peerId).toBe("test-device-id");
    expect(instance.options.endpoint).toBe("http://localhost:8080/ws");
    expect(connect).toHaveBeenCalledTimes(1);

    // Status follows onStateChange.
    await act(async () => {
      instance.options.handlers?.onStateChange?.("connected");
    });
    expect(screen.getByTestId("status")).toHaveTextContent("connected");
  });

  it("closes the socket on unmount", async () => {
    const view = await act(async () => renderWithProvider());
    await act(async () => view.unmount());

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("pairs each connection with a cleanup across remounts (StrictMode-safe)", async () => {
    const view1 = await act(async () => renderWithProvider());
    expect(MockRelayWsClient.instances).toHaveLength(1);
    expect(connect).toHaveBeenCalledTimes(1);

    await act(async () => view1.unmount());
    expect(close).toHaveBeenCalledTimes(1);

    // Remount (as StrictMode's mount→unmount→remount cycle does) must create a
    // fresh client rather than touching the closed one.
    const view2 = await act(async () => renderWithProvider());
    expect(MockRelayWsClient.instances).toHaveLength(2);
    expect(connect).toHaveBeenCalledTimes(2);

    await act(async () => view2.unmount());
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("exposes send and on through useWs", async () => {
    // Send/on are exercised from an event handler, not a mount effect: child
    // effects run before the provider's, so clientRef isn't populated yet when
    // a child effect fires.
    function Probe() {
      const ws = useWs();
      return (
        <button
          data-testid="btn"
          onClick={() => {
            ws.send({ type: "test", payload: {} });
            ws.on("heartbeat", () => {});
          }}
        />
      );
    }

    await act(async () => {
      render(<Probe />, { wrapper: WsProvider });
    });
    await act(async () => {
      screen.getByTestId("btn").click();
    });

    expect(send).toHaveBeenCalledWith({ type: "test", payload: {} });
    expect(on).toHaveBeenCalledWith("heartbeat", expect.any(Function));
  });
});

describe("useWs", () => {
  it("throws when used outside WsProvider", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    function BadComponent() {
      useWs();
      return null;
    }

    expect(() => render(<BadComponent />)).toThrow(
      "useWs must be used within a WsProvider",
    );

    consoleSpy.mockRestore();
  });
});
