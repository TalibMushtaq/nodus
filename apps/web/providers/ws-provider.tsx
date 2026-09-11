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
import { useRouter } from "next/navigation";
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

/** Relay WS endpoint for this browser. An explicit NEXT_PUBLIC_RELAY_URL (dev)
 *  wins; otherwise the single-origin deploy talks to its own `/ws`. No
 *  localhost default is ever baked into the client bundle. */
function relayWsUrl(): string {
  const configured = process.env.NEXT_PUBLIC_RELAY_URL?.trim();
  const base = configured && configured !== "" ? configured : window.location.origin;
  return relayWsEndpoint(base);
}

export function WsProvider({ children }: { children: ReactNode }) {
  // The device identity is this client's peer identity for heartbeats/presence.
  const { device, status: authStatus } = useAuth();
  const router = useRouter();
  const [status, setStatus] = useState<ConnectionState>("disconnected");
  const clientRef = useRef<RelayWsClient | null>(null);
  // This outlives individual RelayWsClient instances. Device changes and React
  // StrictMode recreate the client, but consumers' subscriptions remain valid.
  const subscriptionsRef = useRef(
    new Map<string, Set<(payload: unknown) => void>>(),
  );

  const peerId = device?.device_id ?? "";

  useEffect(() => {
    // Device identity arrives asynchronously (localStorage read in AuthProvider's
    // effect) — delay construction until we have a peerId rather than creating a
    // partially-configured client.
    if (!peerId || authStatus !== "authenticated") {
      return;
    }

    const client = new RelayWsClient({
      endpoint: relayWsUrl(),
      peerId,
      handlers: {
        onStateChange: setStatus,
        onAuthError: () => router.replace("/auth"),
      },
    });
    clientRef.current = client;
    for (const [type, handlers] of subscriptionsRef.current) {
      for (const handler of handlers) client.on(type, handler);
    }
    client.connect();

    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [peerId, authStatus, router]);

  const send = useCallback((msg: WsOutgoing) => {
    // No-op before the client exists or its socket has opened.
    clientRef.current?.send(msg);
  }, []);

  const on = useCallback(
    (type: string, handler: (payload: unknown) => void) => {
      let handlers = subscriptionsRef.current.get(type);
      if (!handlers) {
        handlers = new Set();
        subscriptionsRef.current.set(type, handlers);
      }
      handlers.add(handler);
      clientRef.current?.on(type, handler);
      return () => {
        subscriptionsRef.current.get(type)?.delete(handler);
        clientRef.current?.off(type, handler);
      };
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
