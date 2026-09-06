import { sendShard } from "./data-channel.js";
import { NodusRTCPeerConnection } from "./peer-connection.js";
import {
  type WebRtcShardTransferOptions,
  type WebRtcShardTransferResult,
  WebRtcTransferError,
} from "./types.js";

const DEFAULT_NEGOTIATION_TIMEOUT_MS = 4000;

/**
 * High-level orchestrator that conducts WebRTC negotiation and streams a shard
 * over the resulting DataChannel.
 */
export async function transferShardViaWebRtc(
  opts: WebRtcShardTransferOptions,
): Promise<WebRtcShardTransferResult> {
  const startTime = Date.now();
  const { signalingChannel, shard } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_NEGOTIATION_TIMEOUT_MS;

  let pc: NodusRTCPeerConnection | null = null;
  let dataChannel: RTCDataChannel | null = null;

  try {
    pc = new NodusRTCPeerConnection(
      opts.peerConnectionConfig ?? {},
      {
        onIceCandidate: (candidate) => {
          if (candidate.candidate) {
            signalingChannel
              .sendIceCandidate(JSON.stringify(candidate.toJSON ? candidate.toJSON() : candidate))
              .catch(() => {
                // Best-effort trickle ICE send
              });
          }
        },
        onError: () => {
          // Log or handle internal PC error
        },
      },
      opts.peerConnectionFactory,
    );

    // Setup incoming remote ICE candidate handler
    signalingChannel.onIceCandidate = (candidateStr) => {
      try {
        let parsedCandidate: RTCIceCandidateInit;
        try {
          parsedCandidate = JSON.parse(candidateStr);
        } catch {
          parsedCandidate = { candidate: candidateStr, sdpMid: "0", sdpMLineIndex: 0 };
        }
        pc?.addIceCandidate(parsedCandidate).catch(() => {
          // Ignore late candidate error
        });
      } catch {
        // Ignore candidate parse error
      }
    };

    // Setup incoming remote SDP answer handler
    const answerPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new WebRtcTransferError("TIMEOUT", `Negotiation timed out after ${timeoutMs}ms waiting for answer`));
      }, timeoutMs);

      signalingChannel.onAnswer = (sdp: string) => {
        clearTimeout(timer);
        resolve(sdp);
      };
    });

    // Create reliable ordered DataChannel
    dataChannel = pc.createDataChannel(`nodus-shard-${shard.shardIndex}`, {
      ordered: true,
    });

    // Generate local SDP offer and send via signaling channel
    const offer = await pc.createOffer();
    if (!offer.sdp) {
      throw new WebRtcTransferError("OFFER_FAILED", "Created SDP offer is empty");
    }

    await signalingChannel.sendOffer(offer.sdp);

    // Await SDP answer from peer and set remote description
    const answerSdp = await answerPromise;
    await pc.setRemoteDescription({
      type: "answer",
      sdp: answerSdp,
    });

    // Stream shard bytes over the DataChannel
    const ack = await sendShard(dataChannel, {
      transferId: shard.transferId,
      fileId: shard.fileId,
      versionNumber: shard.versionNumber,
      shardIndex: shard.shardIndex,
      data: shard.data,
      hash: shard.hash,
      targetNode: shard.targetNode,
      sourceDevice: shard.sourceDevice,
      ackTimeoutMs: timeoutMs * 5, // give generous timeout for shard data transmission
      onProgress: opts.onProgress,
    });

    const durationMs = Date.now() - startTime;

    return {
      path: opts.path ?? "A",
      durationMs,
      transferId: shard.transferId,
      bytesTransferred: shard.data.byteLength,
      ack,
    };
  } finally {
    try {
      if (dataChannel && dataChannel.readyState === "open") {
        dataChannel.close();
      }
    } catch {
      // Ignore cleanup error
    }

    try {
      pc?.close();
    } catch {
      // Ignore cleanup error
    }

    signalingChannel.close();
  }
}
