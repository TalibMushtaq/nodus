//! Type-safe WebSocket client for talking to the Relay (`/ws`).
//!
//! Owns the connection lifecycle + envelope framing and delegates message
//! validation to `@repo/protocol`'s `parseMessage`. From Phase 14a this is a
//! production-grade transport: a connection state machine, automatic
//! reconnection with exponential backoff (skipped for auth rejections),
//! a heartbeat loop, presence announcement on connect, and type-keyed message
//! subscriptions on top of the legacy handler bag.

import {
  BaseEnvelopeSchema,
  CURRENT_SCHEMA_VERSION,
  MessageTypes,
  parseMessage,
  type ParseResult,
} from "@repo/protocol";
import { backoffDelayWithRandom } from "@repo/core";

/** Custom close codes shared with the Go Relay (see services/relay/internal/hub). */
export const CLOSE_CODE_UNAUTHORIZED = 4001;

/**
 * Connection state machine. `disconnected` means the client was closed
 * explicitly (or never started); `disconnected_max_retries` is the terminal
 * state after the reconnect budget is exhausted — the UI treats those
 * differently (`disconnected` is user-initiated, `disconnected_max_retries`
 * is a failure that may need a "reconnect" button).
 */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected_max_retries";

/** Derive the relay WS endpoint from an HTTP(S)/WS(s) base URL. */
export function relayWsEndpoint(baseUrl: string): string {
  const stripped = baseUrl
    .trim()
    .replace(/\/ws\/?$/, "")
    .replace(/\/$/, "");
  return stripped.startsWith("ws://") || stripped.startsWith("wss://")
    ? `${stripped}/ws`
    : `${stripped.replace(/^http/, "ws")}/ws`;
}

/** Normalize the raw envelope to the base schema (message_id/schema_version). */
export interface WsOutgoing {
  type: string;
  payload: unknown;
  message_id?: string;
  schema_version?: string;
}

function buildEnvelope(msg: WsOutgoing): string {
  const envelope = BaseEnvelopeSchema.parse({
    type: msg.type,
    schema_version: msg.schema_version ?? CURRENT_SCHEMA_VERSION,
    message_id: msg.message_id ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  });
  return JSON.stringify({ ...envelope, payload: msg.payload });
}

export interface RelayWsHandlers {
  /** Fired for every *validated* incoming envelope; return false to stop. */
  onMessage?: (parsed: ParseResult) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (err: unknown) => void;
  /**
   * Fired when the Relay rejects the connection with the auth close code
   * (4001). Distinct from `onStateChange/disconnected_max_retries` so the UI
   * can redirect to login instead of poking a spinner. No retry is attempted.
   */
  onAuthError?: (code: number, reason: string) => void;
  /** Fired on every connection-state transition. */
  onStateChange?: (state: ConnectionState) => void;
}

export interface RelayWsClientOptions {
  endpoint: string;
  handlers?: RelayWsHandlers;
  /** Required: heartbeat/presence announcements need a stable peer identity. */
  peerId: string;
  reconnect?: { maxRetries: number; baseDelay: number; maxDelay: number };
  heartbeat?: { intervalMs: number };
}

const DEFAULT_RECONNECT = { maxRetries: 10, baseDelay: 1000, maxDelay: 30_000 };
const DEFAULT_HEARTBEAT = { intervalMs: 30_000 };

export class RelayWsClient {
  private ws: WebSocket | null = null;
  private readonly endpoint: string;
  private readonly handlers: RelayWsHandlers;
  private readonly peerId: string;
  private readonly reconnectCfg: {
    maxRetries: number;
    baseDelay: number;
    maxDelay: number;
  };
  private readonly heartbeatCfg: { intervalMs: number };

  private state: ConnectionState = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private explicitClose = false;

  private subscriptions = new Map<string, Set<(payload: unknown) => void>>();

  constructor(endpoint: string, handlers?: RelayWsHandlers);
  constructor(options: RelayWsClientOptions);
  constructor(
    endpointOrOptions: string | RelayWsClientOptions,
    handlers: RelayWsHandlers = {},
  ) {
    if (typeof endpointOrOptions === "string") {
      // Legacy constructor: no peerId, so automatic heartbeats/presence are
      // skipped — `heartbeat(peerId)` remains available as an explicit call.
      this.endpoint = endpointOrOptions;
      this.handlers = handlers;
      this.peerId = "";
      this.reconnectCfg = DEFAULT_RECONNECT;
      this.heartbeatCfg = DEFAULT_HEARTBEAT;
    } else {
      this.endpoint = endpointOrOptions.endpoint;
      this.handlers = endpointOrOptions.handlers ?? {};
      this.peerId = endpointOrOptions.peerId;
      this.reconnectCfg = {
        ...DEFAULT_RECONNECT,
        ...endpointOrOptions.reconnect,
      };
      this.heartbeatCfg = {
        ...DEFAULT_HEARTBEAT,
        ...endpointOrOptions.heartbeat,
      };
    }
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    if (this.state === "connecting" || this.state === "connected") {
      return;
    }

    // A pending reconnect timer is cancelled: either the timer itself is
    // firing (and will null itself before calling this) or the user is
    // explicitly retrying ahead of schedule.
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.explicitClose = false;

    this.setState("connecting");
    const ws = new WebSocket(this.endpoint);
    this.ws = ws;

    ws.onopen = () => {
      // A prior socket can fire after a newer connection was installed.
      // It must never revive state or start a second heartbeat loop.
      if (this.ws !== ws) return;
      this.reconnectAttempt = 0;
      this.setState("connected");
      this.startHeartbeat();
      this.announcePresence();
      this.handlers.onOpen?.();
    };

    ws.onerror = (ev) => {
      if (this.ws === ws) this.handlers.onError?.(ev);
    };

    ws.onclose = (ev) => {
      // Ignore stale callbacks from sockets replaced by a manual reconnect.
      if (this.ws !== ws) return;
      this.stopHeartbeat();
      this.ws = null;
      this.handlers.onClose?.(ev.code, ev.reason);

      if (this.explicitClose) {
        this.explicitClose = false;
        this.setState("disconnected");
        return;
      }

      // Auth rejection is terminal: retrying against a rejected session will
      // never succeed and only hides the real problem behind a spinner.
      if (ev.code === CLOSE_CODE_UNAUTHORIZED) {
        this.setState("disconnected_max_retries");
        this.handlers.onAuthError?.(ev.code, ev.reason);
        return;
      }

      this.scheduleReconnect();
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;

      if (typeof ev.data !== "string") {
        this.handlers.onError?.(new Error("relay sent a non-text frame"));
        ws.close(1003, "non-text relay frame");
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch {
        // A non-JSON frame is a protocol violation; surface via onError so
        // the app can decide whether to drop or reconnect.
        this.handlers.onError?.(new Error("relay sent a non-JSON frame"));
        return;
      }
      const parsed = parseMessage(raw);
      this.handlers.onMessage?.(parsed);

      // Dispatch to type-specific subscriptions.
      if (parsed.ok) {
        const handlers = this.subscriptions.get(parsed.message.type);
        if (handlers) {
          for (const handler of handlers) {
            handler(parsed.message.payload);
          }
        }
      }
    };
  }

  /**
   * Subscribe to a message type. Returns an unsubscribe function; use `off()`
   * when you want to remove a specific handler explicitly.
   */
  on(type: string, handler: (payload: unknown) => void): () => void {
    if (!this.subscriptions.has(type)) {
      this.subscriptions.set(type, new Set());
    }
    this.subscriptions.get(type)!.add(handler);
    return () => {
      this.subscriptions.get(type)?.delete(handler);
    };
  }

  off(type: string, handler: (payload: unknown) => void): void {
    this.subscriptions.get(type)?.delete(handler);
  }

  send(msg: WsOutgoing): void {
    if (!this.connected) {
      return;
    }
    this.ws!.send(buildEnvelope(msg));
  }

  /** Convenience: fire a heartbeat to refresh Relay-side presence. */
  heartbeat(peerId: string): void {
    this.send({ type: MessageTypes.HEARTBEAT, payload: { id: peerId } });
  }

  close(code = 1000, reason = "client closing"): void {
    // Idempotent: safe to call on an already-closed or never-opened client
    // (needed for React StrictMode's mount→unmount→remount cycle).
    this.explicitClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.ws?.close(code, reason);
    this.ws = null;
    this.setState("disconnected");
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.handlers.onStateChange?.(next);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= this.reconnectCfg.maxRetries) {
      this.setState("disconnected_max_retries");
      return;
    }

    this.setState("reconnecting");

    const delayMs = Math.min(
      backoffDelayWithRandom(
        this.reconnectAttempt,
        this.reconnectCfg.baseDelay,
        this.reconnectCfg.baseDelay,
      ),
      this.reconnectCfg.maxDelay,
    );
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (!this.peerId) {
      return; // legacy clients without a peerId send heartbeats manually
    }
    this.heartbeatTimer = setInterval(() => {
      try {
        this.heartbeat(this.peerId);
      } catch {
        // A failing heartbeat means the connection is dead even though the
        // socket hasn't surfaced it yet; force the reconnect path.
        this.stopHeartbeat();
        this.explicitClose = false;
        this.ws?.close(1006, "heartbeat failed");
      }
    }, this.heartbeatCfg.intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Presence announcement sent immediately after connect (before the loop). */
  private announcePresence(): void {
    if (!this.peerId) {
      return;
    }
    try {
      // Same protocol control message the heartbeat loop uses; refreshing the
      // Relay-side presence right away instead of waiting one interval.
      this.heartbeat(this.peerId);
    } catch {
      // Connection dropped between open and this send; the heartbeat loop (or
      // a reconnect) will surface it.
    }
  }
}
