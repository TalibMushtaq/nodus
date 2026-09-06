import {
  MessageTypes,
  type ParseResult,
  WebRTCAnswerPayloadSchema,
  WebRTCIceCandidatePayloadSchema,
  WebRTCOfferPayloadSchema,
} from "@repo/protocol";
import type { RelayWsClient } from "@repo/relay-client";
import type { SignalingChannel } from "./types.js";

/** Local HTTP signaling channel for Path A */
export interface LocalSignalingOptions {
  baseUrl: string;
  sessionId?: string;
  deviceId?: string;
  timeoutMs?: number;
}

export function createLocalSignalingChannel(opts: LocalSignalingOptions): SignalingChannel {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const sessionId = opts.sessionId ?? (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2));
  const deviceId = opts.deviceId ?? "device_local";
  const timeoutMs = opts.timeoutMs ?? 5000;
  const abortController = new AbortController();

  let onAnswerCb: ((sdp: string) => void) | null = null;
  let onIceCandidateCb: ((candidate: string) => void) | null = null;
  let sseSource: EventSource | null = null;

  // Start receiving ICE candidates via SSE if EventSource is available
  if (typeof EventSource !== "undefined") {
    const sseUrl = `${baseUrl}/nodus/webrtc/ice-candidates?session_id=${encodeURIComponent(sessionId)}&device_id=${encodeURIComponent(deviceId)}`;
    try {
      sseSource = new EventSource(sseUrl);
      sseSource.addEventListener("candidate", (event) => {
        if (event.data) {
          onIceCandidateCb?.(event.data);
        }
      });
      sseSource.onerror = () => {
        // SSE error or reconnection attempt
      };
    } catch {
      // EventSource failed to instantiate (e.g. non-browser environment)
    }
  }

  return {
    get onAnswer() {
      return onAnswerCb;
    },
    set onAnswer(cb: ((sdp: string) => void) | null) {
      onAnswerCb = cb;
    },
    get onIceCandidate() {
      return onIceCandidateCb;
    },
    set onIceCandidate(cb: ((candidate: string) => void) | null) {
      onIceCandidateCb = cb;
    },

    async sendOffer(sdp: string): Promise<void> {
      const res = await fetch(`${baseUrl}/nodus/webrtc/offer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          device_id: deviceId,
          sdp,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        throw new Error(`Local signaling offer failed: HTTP ${res.status} ${await res.text()}`);
      }

      const body = (await res.json()) as { sdp?: string; answer?: string };
      const answerSdp = body.sdp ?? body.answer;
      if (answerSdp && onAnswerCb) {
        onAnswerCb(answerSdp);
      }
    },

    async sendAnswer(sdp: string): Promise<void> {
      const res = await fetch(`${baseUrl}/nodus/webrtc/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          device_id: deviceId,
          sdp,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        throw new Error(`Local signaling answer failed: HTTP ${res.status}`);
      }
    },

    async sendIceCandidate(candidate: string): Promise<void> {
      const res = await fetch(`${baseUrl}/nodus/webrtc/ice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          device_id: deviceId,
          candidate,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        throw new Error(`Local signaling ICE push failed: HTTP ${res.status}`);
      }
    },

    close(): void {
      abortController.abort();
      if (sseSource) {
        sseSource.close();
        sseSource = null;
      }
      onAnswerCb = null;
      onIceCandidateCb = null;
    },
  };
}

/** Relay-mediated signaling channel for Path B */
export function createRelaySignalingChannel(
  wsClient: RelayWsClient,
  fromPeer: string,
  toPeer: string,
): SignalingChannel & { handleMessage: (parsed: ParseResult) => void } {
  let onAnswerCb: ((sdp: string) => void) | null = null;
  let onIceCandidateCb: ((candidate: string) => void) | null = null;

  const handleMessage = (parsed: ParseResult) => {
    if (!parsed.ok) return;
    const { message } = parsed;

    if (message.type === MessageTypes.WEBRTC_ANSWER) {
      const payload = WebRTCAnswerPayloadSchema.safeParse(message.payload);
      if (payload.success && payload.data.to_peer === fromPeer) {
        onAnswerCb?.(payload.data.sdp);
      }
    } else if (message.type === MessageTypes.WEBRTC_ICE_CANDIDATE) {
      const payload = WebRTCIceCandidatePayloadSchema.safeParse(message.payload);
      if (payload.success && payload.data.to_peer === fromPeer) {
        onIceCandidateCb?.(payload.data.candidate);
      }
    } else if (message.type === MessageTypes.WEBRTC_OFFER) {
      const payload = WebRTCOfferPayloadSchema.safeParse(message.payload);
      if (payload.success && payload.data.to_peer === fromPeer) {
        onAnswerCb?.(payload.data.sdp);
      }
    }
  };

  return {
    get onAnswer() {
      return onAnswerCb;
    },
    set onAnswer(cb: ((sdp: string) => void) | null) {
      onAnswerCb = cb;
    },
    get onIceCandidate() {
      return onIceCandidateCb;
    },
    set onIceCandidate(cb: ((candidate: string) => void) | null) {
      onIceCandidateCb = cb;
    },

    handleMessage(parsed: ParseResult): void {
      handleMessage(parsed);
    },

    async sendOffer(sdp: string): Promise<void> {
      wsClient.send({
        type: MessageTypes.WEBRTC_OFFER,
        payload: {
          from_peer: fromPeer,
          to_peer: toPeer,
          sdp,
        },
      });
    },

    async sendAnswer(sdp: string): Promise<void> {
      wsClient.send({
        type: MessageTypes.WEBRTC_ANSWER,
        payload: {
          from_peer: fromPeer,
          to_peer: toPeer,
          sdp,
        },
      });
    },

    async sendIceCandidate(candidate: string): Promise<void> {
      wsClient.send({
        type: MessageTypes.WEBRTC_ICE_CANDIDATE,
        payload: {
          from_peer: fromPeer,
          to_peer: toPeer,
          candidate,
        },
      });
    },

    close(): void {
      onAnswerCb = null;
      onIceCandidateCb = null;
    },
  };
}
