import { describe, expect, it } from "vitest";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import { transferShardViaWebRtc } from "../src/transfer.js";
import { MockRTCDataChannel } from "./mock-datachannel.js";
import type { SignalingChannel } from "../src/types.js";
import { receiveShard } from "../src/data-channel.js";

describe("transferShardViaWebRtc orchestrator", () => {
  it("negotiates and transfers shard using mock peer connection factory", async () => {
    const payload = new Uint8Array([100, 101, 102, 103, 104]);
    const hash = bytesToHex(blake3(payload));

    const [clientChan, serverChan] = MockRTCDataChannel.createPair("nodus-shard-0");

    // Mock signaling channel
    const mockSignaling: SignalingChannel = {
      sendOffer: async () => {
        // Echo answer immediately
        setTimeout(() => {
          mockSignaling.onAnswer?.("v=0\r\nanswer-mock");
        }, 10);
      },
      sendAnswer: async () => {},
      sendIceCandidate: async () => {},
      onAnswer: null,
      onIceCandidate: null,
      close: () => {},
    };

    // Mock RTCPeerConnection factory for deterministic unit testing
    const mockFactory = () => {
      const pc = {
        connectionState: "connected",
        iceConnectionState: "connected",
        createOffer: async () => ({ type: "offer" as RTCSdpType, sdp: "v=0\r\noffer-mock" }),
        createAnswer: async () => ({ type: "answer" as RTCSdpType, sdp: "v=0\r\nanswer-mock" }),
        setLocalDescription: async () => {},
        setRemoteDescription: async () => {},
        addIceCandidate: async () => {},
        createDataChannel: () => clientChan as unknown as RTCDataChannel,
        close: () => {},
      };
      return pc as unknown as RTCPeerConnection;
    };

    // Server-side receiver
    const serverReceivePromise = receiveShard({
      channel: serverChan as unknown as RTCDataChannel,
      expectedHash: hash,
      expectedSize: payload.byteLength,
    });

    // Client-side transfer
    const transferPromise = transferShardViaWebRtc({
      signalingChannel: mockSignaling,
      peerConnectionFactory: mockFactory,
      shard: {
        transferId: "tr-test-01",
        fileId: "00000000-0000-0000-0000-000000000001",
        versionNumber: 1,
        shardIndex: 0,
        data: payload,
        hash,
      },
    });

    const [clientRes, serverRes] = await Promise.all([transferPromise, serverReceivePromise]);

    expect(clientRes.transferId).toBe("tr-test-01");
    expect(clientRes.ack.status).toBe("verified");
    expect(serverRes.data).toEqual(payload);
  });
});
