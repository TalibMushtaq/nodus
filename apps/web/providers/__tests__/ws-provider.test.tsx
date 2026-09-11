import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { WsProvider, useWs } from "../ws-provider";

const { MockRelayWsClient, connect, close, on, off, send, replace, authState } =
  vi.hoisted(() => {
    const connect = vi.fn();
    const close = vi.fn();
    const on = vi.fn(() => () => {});
    const off = vi.fn();
    const send = vi.fn();
    const replace = vi.fn();
    const authState = { deviceId: "test-device-id", status: "authenticated" };

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
      off = off;
      send = send;

      constructor(options: MockRelayWsClient["options"]) {
        this.options = options;
        MockRelayWsClient.instances.push(this);
      }
    }

    return {
      MockRelayWsClient,
      connect,
      close,
      on,
      off,
      send,
      replace,
      authState,
    };
  });

vi.mock("@repo/relay-client", () => ({
  RelayWsClient: MockRelayWsClient,
  relayWsEndpoint: (baseUrl: string) => `${baseUrl}/ws`,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

vi.mock("../auth-provider", () => ({
  useAuth: () => ({
    // Single stable identity; the provider derives its peerId from this.
    device: { device_id: authState.deviceId },
    status: authState.status,
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
  authState.deviceId = "test-device-id";
  authState.status = "authenticated";
});

describe("WsProvider", () => {
  it("constructs a client with the device peerId and connects", async () => {
    await act(async () => {
      renderWithProvider();
    });

    expect(MockRelayWsClient.instances).toHaveLength(1);
    const instance = MockRelayWsClient.instances[0]!;
    expect(instance.options.peerId).toBe("test-device-id");
    // No NEXT_PUBLIC_RELAY_URL and no localhost default: same-origin /ws.
    expect(instance.options.endpoint).toBe("http://localhost/ws");
    expect(connect).toHaveBeenCalledTimes(1);

    // Status follows onStateChange.
    await act(async () => {
      instance.options.handlers?.onStateChange?.("connected");
    });
    expect(screen.getByTestId("status")).toHaveTextContent("connected");
  });

  it("honors an explicit NEXT_PUBLIC_RELAY_URL override", async () => {
    process.env.NEXT_PUBLIC_RELAY_URL = "http://relay.example:9000";
    try {
      await act(async () => {
        renderWithProvider();
      });
      expect(MockRelayWsClient.instances[0]!.options.endpoint).toBe(
        "http://relay.example:9000/ws",
      );
    } finally {
      delete process.env.NEXT_PUBLIC_RELAY_URL;
    }
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

  it("keeps subscriptions when its client is recreated", async () => {
    let unsubscribe: (() => void) | undefined;
    function Probe() {
      const ws = useWs();
      return (
        <button
          data-testid="subscribe"
          onClick={() => {
            unsubscribe = ws.on("heartbeat", () => {});
          }}
        />
      );
    }
    const view = render(
      <WsProvider>
        <Probe />
      </WsProvider>,
    );
    await act(async () => screen.getByTestId("subscribe").click());
    expect(on).toHaveBeenCalledTimes(1);

    authState.deviceId = "replacement-device-id";
    await act(async () =>
      view.rerender(
        <WsProvider>
          <Probe />
        </WsProvider>,
      ),
    );
    expect(on).toHaveBeenCalledTimes(2);
    unsubscribe?.();
    expect(off).toHaveBeenCalledWith("heartbeat", expect.any(Function));
  });

  it("redirects to auth when the relay rejects the session", async () => {
    await act(async () => {
      renderWithProvider();
    });
    MockRelayWsClient.instances[0]!.options.handlers?.onAuthError?.(
      4001,
      "unauthorized",
    );
    expect(replace).toHaveBeenCalledWith("/auth");
  });

  it("connects after authentication and closes when the session ends", async () => {
    authState.status = "unauthenticated";
    const view = renderWithProvider();
    expect(connect).not.toHaveBeenCalled();

    authState.status = "authenticated";
    await act(async () => view.rerender(<StatusProbe />));
    expect(connect).toHaveBeenCalledTimes(1);

    authState.status = "unauthenticated";
    await act(async () => view.rerender(<StatusProbe />));
    expect(close).toHaveBeenCalledTimes(1);
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
