import { MessageTypes } from "@repo/protocol";
import { hashShard } from "@repo/core";
import type { SignalingChannel } from "@repo/webrtc-transport";

// Path B signaling over the Relay WebSocket. The browser sends `webrtc_offer`
// and trickle ICE to the node, and the node's `webrtc_answer`/ICE come back on
// the same socket. The Relay forwards these envelopes without inspecting them
// (it never sees file bytes). This is a browser-side counterpart to the shared
// `createRelaySignalingChannel`, adapted to the app's WsProvider `send`/`on`
// surface instead of a raw RelayWsClient.
//
// Envelopes are filtered by the pair of peer ids: only messages addressed to
// this device (`to_peer === fromPeer`) and originating from the target node
// (`from_peer === toPeer`) are accepted, so an unrelated concurrent session
// cannot feed us its SDP/ICE.

export interface BrowserRelayChannelDeps {
  /** WsProvider `send` — envelopes are routed by the Relay. */
  send: (msg: { type: string; payload: unknown }) => void;
  /** WsProvider `on` — subscribes to inbound envelopes by message type. */
  on: (type: string, handler: (payload: unknown) => void) => () => void;
  /** This browser's device id. */
  fromPeer: string;
  /** The storage node's id. */
  toPeer: string;
  /**
   * Signs a message with the device key (`signDeviceMessage` over the Ed25519
   * identity). The node verifies it before opening a session, so a compromised
   * Relay cannot forge an offer from this device. Message shape mirrors the LAN
   * path: `"{device}:{session}:{timestamp}:{blake3(payload)}"`, with the session
   * id the node derives for relay sessions (`relay-<device>`).
   */
  sign?: (message: string) => string | Promise<string>;
}

/** The session id the node derives for a relay-signaled session. */
function relaySessionId(deviceId: string): string {
  return `relay-${deviceId}`;
}

export function createBrowserRelayChannel(deps: BrowserRelayChannelDeps): SignalingChannel {
  const { send, on, fromPeer, toPeer, sign } = deps;

  // Bind device + payload into a signed, time-stamped message so the node can
  // verify freshness and integrity. Unsigned when no signer was provided (the
  // node then rejects the offer and the executor falls through to Path C).
  async function signedFields(
    payload: string,
  ): Promise<{ timestamp?: number; signature?: string }> {
    if (!sign) return {};
    const timestamp = Date.now();
    const digest = hashShard(new TextEncoder().encode(payload));
    const signature = await sign(`${fromPeer}:${relaySessionId(fromPeer)}:${timestamp}:${digest}`);
    return { timestamp, signature };
  }

  let onAnswerCb: ((sdp: string) => void) | null = null;
  let onIceCandidateCb: ((candidate: string) => void) | null = null;

  const unsubscribers = [
    on(MessageTypes.WEBRTC_ANSWER, (payload) => {
      const answer = payload as { from_peer?: unknown; to_peer?: unknown; sdp?: unknown } | null;
      if (
        answer?.to_peer === fromPeer &&
        answer.from_peer === toPeer &&
        typeof answer.sdp === "string"
      ) {
        onAnswerCb?.(answer.sdp);
      }
    }),
    on(MessageTypes.WEBRTC_ICE_CANDIDATE, (payload) => {
      const ice = payload as { from_peer?: unknown; to_peer?: unknown; candidate?: unknown } | null;
      if (
        ice?.to_peer === fromPeer &&
        ice.from_peer === toPeer &&
        typeof ice.candidate === "string"
      ) {
        onIceCandidateCb?.(ice.candidate);
      }
    }),
  ];

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
      const fields = await signedFields(sdp);
      send({
        type: MessageTypes.WEBRTC_OFFER,
        payload: { from_peer: fromPeer, to_peer: toPeer, sdp, ...fields },
      });
    },

    async sendAnswer(sdp: string): Promise<void> {
      send({
        type: MessageTypes.WEBRTC_ANSWER,
        payload: { from_peer: fromPeer, to_peer: toPeer, sdp },
      });
    },

    async sendIceCandidate(candidate: string): Promise<void> {
      const fields = await signedFields(candidate);
      send({
        type: MessageTypes.WEBRTC_ICE_CANDIDATE,
        payload: { from_peer: fromPeer, to_peer: toPeer, candidate, ...fields },
      });
    },

    close(): void {
      for (const unsubscribe of unsubscribers) unsubscribe();
      onAnswerCb = null;
      onIceCandidateCb = null;
    },
  };
}
