//! Minimal type-safe WebSocket client for talking to the Relay (`/ws`).
//!
//! This is intentionally thin: it owns the connection lifecycle + envelope
//! framing and delegates message validation to `@repo/protocol`'s
//! `parseMessage`. Higher-level flows (sync, pairing-session creation over
//! HTTP) build on top of it; the immediate Phase 11 consumer uses it only to
//! detect node presence (heartbeats) and to receive `pairing_token_push`
//! notifications forwarded to the device's UI.

import {
  BaseEnvelopeSchema,
  CURRENT_SCHEMA_VERSION,
  MessageTypes,
  parseMessage,
  type ParseResult,
} from "@repo/protocol";

/** Derive the relay WS endpoint from an HTTP(S)/WS(s) base URL. */
export function relayWsEndpoint(baseUrl: string): string {
  const stripped = baseUrl.trim().replace(/\/ws\/?$/, "");
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
}

/**
 * One WebSocket connection to the Relay. `connect()` is fire-and-forget state;
 * use `ready`/event handlers for lifecycle. Reconnect policy is the caller's
 * concern (apps layer), because only the app knows its auth/backoff budget.
 */
export class RelayWsClient {
  private ws: WebSocket | null = null;
  private readonly endpoint: string;
  private readonly handlers: RelayWsHandlers;

  constructor(endpoint: string, handlers: RelayWsHandlers = {}) {
    this.endpoint = endpoint;
    this.handlers = handlers;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): void {
    const ws = new WebSocket(this.endpoint);
    this.ws = ws;
    ws.onopen = () => this.handlers.onOpen?.();
    ws.onerror = (ev) => this.handlers.onError?.(ev);
    ws.onclose = (ev) => this.handlers.onClose?.(ev.code, ev.reason);
    ws.onmessage = (ev) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(ev.data));
      } catch {
        // A non-JSON frame is a protocol violation; surface via onError so
        // the app can decide whether to drop or reconnect.
        this.handlers.onError?.(new Error("relay sent a non-JSON frame"));
        return;
      }
      const parsed = parseMessage(raw);
      this.handlers.onMessage?.(parsed);
    };
  }

  send(msg: WsOutgoing): void {
    if (!this.connected) {
      throw new Error("relay ws client is not connected");
    }
    this.ws!.send(buildEnvelope(msg));
  }

  /** Convenience: fire a heartbeat to refresh Relay-side presence. */
  heartbeat(peerId: string): void {
    this.send({ type: MessageTypes.HEARTBEAT, payload: { id: peerId } });
  }

  close(code = 1000, reason = "client closing"): void {
    this.ws?.close(code, reason);
    this.ws = null;
  }
}