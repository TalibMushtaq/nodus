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
import { MessageTypes, type BatchAckPayload, type EventPayload } from "@repo/protocol";

import { currentSessionToken, RELAY_BASE } from "./adapters";

type MessageHandler = (payload: unknown) => void;

/** How long to wait for a `batch_ack` before failing the batch. */
const EVENT_ACK_TIMEOUT_MS = 10_000;

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
  /** Serializes event batches: the Relay's `batch_ack` carries no correlation id. */
  private batchTail: Promise<unknown> = Promise.resolve();

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

  /**
   * Send one sync-event batch and resolve with its ack.
   *
   * The Relay's `batch_ack` carries no correlation id, so batches are chained:
   * two overlapping batches must not race for the same ack. Mirrors the web
   * `useEventBatch` helper.
   */
  sendEventBatch(events: EventPayload[]): Promise<BatchAckPayload> {
    const run = () =>
      new Promise<BatchAckPayload>((resolve, reject) => {
        let off: () => void = () => undefined;
        const timer = setTimeout(() => {
          off();
          reject(new Error("timed out waiting for batch_ack"));
        }, EVENT_ACK_TIMEOUT_MS);
        off = this.on("batch_ack", (payload) => {
          clearTimeout(timer);
          off();
          resolve(payload as BatchAckPayload);
        });
        this.send(MessageTypes.EVENT_BATCH, { events });
      });
    const next = this.batchTail.then(run, run);
    this.batchTail = next.catch(() => undefined);
    return next;
  }
}
