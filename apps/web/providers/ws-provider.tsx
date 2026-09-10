"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { RelayWsClient, relayWsEndpoint } from "@repo/relay-client";
import type { ConnectionState, WsOutgoing } from "@repo/relay-client";

import { useAuth } from "./auth-provider";

// WsProvider owns the app's single WebSocket connection to the Relay. The
// RelayWsClient is constructed inside the effect (not memoized at render) so
// React StrictMode's mount→unmount→remount cycle pairs each client with its
// own cleanup — close() is idempotent, so the double-effect in dev never
// leaks a socket.

interface WsContextValue {
  status: ConnectionState;
  send: (msg: WsOutgoing) => void;
  on: (type: string, handler: (payload: unknown) => void) => () => void;
}

const WsContext = createContext<WsContextValue | null>(null);

/** Relay WS endpoint; mirrors the server-side RELAY_URL default (lib/relay.ts). */
function relayWsUrl(): string {
  return relayWsEndpoint(
    process.env.NEXT_PUBLIC_RELAY_URL ?? "http://localhost:8080",
  );
}

export function WsProvider({ children }: { children: ReactNode }) {
  // The device identity is this client's peer identity for heartbeats/presence.
  const { device } = useAuth();
  const [status, setStatus] = useState<ConnectionState>("disconnected");
  const clientRef = useRef<RelayWsClient | null>(null);

  const peerId = device?.device_id ?? "";

  useEffect(() => {
    // Device identity arrives asynchronously (localStorage read in AuthProvider's
    // effect) — delay construction until we have a peerId rather than creating a
    // partially-configured client.
    if (!peerId) {
      return;
    }

    const client = new RelayWsClient({
      endpoint: relayWsUrl(),
      peerId,
      handlers: {
        onStateChange: setStatus,
        // Auth rejection lands here AND in `status` as disconnected_max_retries;
        // the UI can hook this to redirect to /auth when wired up.
        onAuthError: () => {},
      },
    });
    clientRef.current = client;
    client.connect();

    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [peerId]);

  const send = useCallback((msg: WsOutgoing) => {
    // No-op before the client exists; throws upstream if not connected.
    clientRef.current?.send(msg);
  }, []);

  const on = useCallback(
    (type: string, handler: (payload: unknown) => void) => {
      return clientRef.current?.on(type, handler) ?? (() => {});
    },
    [],
  );

  const value = useMemo(() => ({ status, send, on }), [status, send, on]);

  return <WsContext.Provider value={value}>{children}</WsContext.Provider>;
}

export function useWs(): WsContextValue {
  const ctx = useContext(WsContext);
  if (!ctx) {
    throw new Error("useWs must be used within a WsProvider");
  }
  return ctx;
}
