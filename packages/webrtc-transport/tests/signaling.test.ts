import type { RelayWsClient } from "@repo/relay-client";
import { describe, expect, it, vi } from "vitest";
import { MessageTypes } from "@repo/protocol";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import { createRelaySignalingChannel, createLocalSignalingChannel } from "../src/signaling.js";

describe("WebRTC Signaling Channels", () => {
  it("local signaling binds the signed message to the payload hash", async () => {
    const seen: string[] = [];
    const sign = (message: string) => {
      seen.push(message);
      return "00";
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ sdp: "v=0 answer" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const channel = createLocalSignalingChannel({
        baseUrl: "http://127.0.0.1:9378",
        deviceId: "dev",
        sessionId: "sess",
        sign,
      });
      await channel.sendOffer("v=0 offer");
      channel.close();

      // `dev:sess:<timestamp_ms>:<blake3(sdp)>` — the payload binding is what
      // stops an on-path attacker swapping SDP behind a valid signature.
      const expectedHash = bytesToHex(blake3(new TextEncoder().encode("v=0 offer")));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/^dev:sess:\d+:[0-9a-f]{64}$/);
      expect(seen[0]).toBe(`dev:sess:${seen[0]!.split(":")[2]}:${expectedHash}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
