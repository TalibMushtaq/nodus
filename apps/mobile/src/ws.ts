/**
 * Native Relay WebSocket client.
 *
 * The browser's WS handshake rides the HttpOnly session cookie automatically;
 * React Native has no cookie jar for sockets, so this injects the same opaque
 * session ID as `Authorization: Bearer` through the RelayWsClient's
 * `webSocketFactory` hook (the Relay accepts cookie-or-bearer on /ws). One
 * client is kept for the app session; presence/heartbeats come from the shared
 * client's `peerId`.
 */

import { RelayWsClient, relayWsEndpoint, type ConnectionState } from "@repo/relay-client";

import { currentSessionToken, RELAY_BASE } from "./adapters";

type MessageHandler = (payload: unknown) => void;

export interface MobileWsCallbacks {
  onStateChange?: (state: ConnectionState) => void;
  /** Relay rejected the session (close code 4001); the app should sign out. */
  onAuthError?: () => void;
}

/** React Native's WebSocket accepts a headers bag the DOM type omits. */
type RNWebSocketCtor = new (
  url: string,
  protocols: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket;

export class MobileWs {
  private client: RelayWsClient | null = null;

  get state(): ConnectionState {
    return this.client?.connectionState ?? "disconnected";
  }

  /** True only when the socket can carry traffic (Path B signaling gate). */
  get isConnected(): boolean {
    return this.state === "connected";
  }

  /** Start (or restart) the socket for `deviceId`. Safe to call when already started. */
  start(deviceId: string, callbacks: MobileWsCallbacks = {}): void {
    this.stop();
    if (!RELAY_BASE) {
      // No relay configured: nothing to connect to (operator must set the URL).
      return;
    }

    const RNWebSocket = WebSocket as unknown as RNWebSocketCtor;
    this.client = new RelayWsClient({
      endpoint: relayWsEndpoint(RELAY_BASE),
      peerId: deviceId,
      handlers: {
        onStateChange: callbacks.onStateChange,
        onAuthError: callbacks.onAuthError,
      },
      // Read the token lazily on every (re)connect so a refreshed session is
      // picked up without rebuilding the client.
      webSocketFactory: (url) => {
        const token = currentSessionToken();
        return new RNWebSocket(url, null, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
      },
    });
    this.client.connect();
  }

  stop(): void {
    this.client?.close();
    this.client = null;
  }

  send(type: string, payload: unknown): void {
    this.client?.send({ type, payload });
  }

  /**
   * Subscribe to a message type; survives reconnects (subscriptions are keyed
   * on the client). Returns an unsubscribe function.
   */
  on(type: string, handler: MessageHandler): () => void {
    return this.client?.on(type, handler) ?? (() => undefined);
  }
}
