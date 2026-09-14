import { describe, expect, it } from "vitest";
import { MessageTypes } from "@repo/protocol";
import { hashShard } from "@repo/core";

import { createBrowserRelayChannel } from "../transfer/relay-signaling";

// Minimal WsProvider stand-in: records outbound envelopes and lets a test play
// an inbound one into the registered handlers.
function harness() {
  const sent: { type: string; payload: Record<string, unknown> }[] = [];
  const handlers = new Map<string, Set<(payload: unknown) => void>>();

  const send = (msg: { type: string; payload: unknown }) => {
    sent.push(msg as { type: string; payload: Record<string, unknown> });
  };
  const on = (type: string, handler: (payload: unknown) => void) => {
    let set = handlers.get(type);
    if (!set) {
      set = new Set();
      handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      handlers.get(type)?.delete(handler);
    };
  };
  const emit = (type: string, payload: unknown) => {
    for (const handler of handlers.get(type) ?? []) handler(payload);
  };

  return { sent, send, on, emit };
}

describe("createBrowserRelayChannel", () => {
  it("signs and addresses an offer to the node", async () => {
    const h = harness();
    const signed: string[] = [];
    const channel = createBrowserRelayChannel({
      send: h.send,
      on: h.on,
      fromPeer: "dev-1",
      toPeer: "node-1",
      sign: (message) => {
        signed.push(message);
        return "ab".repeat(64);
      },
    });

    await channel.sendOffer("v=0-offer");

    expect(h.sent).toHaveLength(1);
    const offer = h.sent[0]!;
    expect(offer.type).toBe(MessageTypes.WEBRTC_OFFER);
    expect(offer.payload).toMatchObject({
      from_peer: "dev-1",
      to_peer: "node-1",
      sdp: "v=0-offer",
      signature: "ab".repeat(64),
    });
    // The signed message binds device, the node's derived relay session id,
    // the timestamp, and the payload hash — exactly what the node recomputes.
    const digest = hashShard(new TextEncoder().encode("v=0-offer"));
    expect(signed[0]).toBe(`dev-1:relay-dev-1:${offer.payload.timestamp}:${digest}`);
  });

  it("delivers an answer only from the target node to this device", () => {
    const h = harness();
    const channel = createBrowserRelayChannel({ send: h.send, on: h.on, fromPeer: "dev-1", toPeer: "node-1" });
    const answers: string[] = [];
    channel.onAnswer = (sdp) => answers.push(sdp);

    h.emit(MessageTypes.WEBRTC_ANSWER, { from_peer: "node-1", to_peer: "dev-1", sdp: "good" });
    h.emit(MessageTypes.WEBRTC_ANSWER, { from_peer: "node-9", to_peer: "dev-1", sdp: "wrong-node" });
    h.emit(MessageTypes.WEBRTC_ANSWER, { from_peer: "node-1", to_peer: "dev-x", sdp: "wrong-device" });

    expect(answers).toEqual(["good"]);
  });

  it("relays ICE candidates in both directions", async () => {
    const h = harness();
    const channel = createBrowserRelayChannel({ send: h.send, on: h.on, fromPeer: "dev-1", toPeer: "node-1" });
    const candidates: string[] = [];
    channel.onIceCandidate = (candidate) => candidates.push(candidate);

    await channel.sendIceCandidate("candidate:local");
    h.emit(MessageTypes.WEBRTC_ICE_CANDIDATE, {
      from_peer: "node-1",
      to_peer: "dev-1",
      candidate: "candidate:remote",
    });

    expect(h.sent[0]!.type).toBe(MessageTypes.WEBRTC_ICE_CANDIDATE);
    expect(h.sent[0]!.payload).toMatchObject({ from_peer: "dev-1", to_peer: "node-1", candidate: "candidate:local" });
    expect(candidates).toEqual(["candidate:remote"]);
  });

  it("stops delivering after close()", () => {
    const h = harness();
    const channel = createBrowserRelayChannel({ send: h.send, on: h.on, fromPeer: "dev-1", toPeer: "node-1" });
    const answers: string[] = [];
    channel.onAnswer = (sdp) => answers.push(sdp);

    channel.close();
    h.emit(MessageTypes.WEBRTC_ANSWER, { from_peer: "node-1", to_peer: "dev-1", sdp: "late" });

    expect(answers).toEqual([]);
  });
});
