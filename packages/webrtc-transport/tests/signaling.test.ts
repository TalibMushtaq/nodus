import type { RelayWsClient } from "@repo/relay-client";
import { describe, expect, it, vi } from "vitest";
import { MessageTypes } from "@repo/protocol";
import { createRelaySignalingChannel } from "../src/signaling.js";

describe("WebRTC Signaling Channels", () => {
  it("relay signaling channel correctly formats outgoing envelopes and forwards incoming messages", async () => {
    const sentMessages: unknown[] = [];
    const mockWsClient = {
      send: vi.fn((msg: unknown) => {
        sentMessages.push(msg);
      }),
    } as unknown as RelayWsClient;

    const channel = createRelaySignalingChannel(
      mockWsClient,
      "device-123",
      "node-456",
    );

    // Test sendOffer
    await channel.sendOffer("v=0\r\no=mock-sdp-offer");
    expect(mockWsClient.send).toHaveBeenCalledWith({
      type: MessageTypes.WEBRTC_OFFER,
      payload: {
        from_peer: "device-123",
        to_peer: "node-456",
        sdp: "v=0\r\no=mock-sdp-offer",
      },
    });

    // Test sendAnswer
    await channel.sendAnswer("v=0\r\no=mock-sdp-answer");
    expect(mockWsClient.send).toHaveBeenCalledWith({
      type: MessageTypes.WEBRTC_ANSWER,
      payload: {
        from_peer: "device-123",
        to_peer: "node-456",
        sdp: "v=0\r\no=mock-sdp-answer",
      },
    });

    // Test sendIceCandidate
    await channel.sendIceCandidate("candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host");
    expect(mockWsClient.send).toHaveBeenCalledWith({
      type: MessageTypes.WEBRTC_ICE_CANDIDATE,
      payload: {
        from_peer: "device-123",
        to_peer: "node-456",
        candidate: "candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host",
      },
    });

    channel.close();
  });
});
