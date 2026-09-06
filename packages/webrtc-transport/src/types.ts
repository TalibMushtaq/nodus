import type { ShardAckPayload } from "@repo/protocol";

export type PeerConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export interface PeerConnectionConfig {
  iceServers?: RTCIceServer[];
}

export interface PeerConnectionEvents {
  onIceCandidate?: (candidate: RTCIceCandidate) => void;
  onDataChannel?: (channel: RTCDataChannel) => void;
  onStateChange?: (state: PeerConnectionState) => void;
  onError?: (error: unknown) => void;
}

export interface ShardSendOptions {
  transferId: string;
  fileId: string;
  versionNumber: number;
  shardIndex: number;
  data: Uint8Array;
  hash: string;
  targetNode?: string;
  sourceDevice?: string;
  ackTimeoutMs?: number;
  onProgress?: (bytesSent: number, totalBytes: number) => void;
}

export interface ShardReceiveOptions {
  channel: RTCDataChannel;
  expectedHash: string;
  expectedSize: number;
  timeoutMs?: number;
}

export interface SignalingChannel {
  sendOffer(sdp: string): Promise<void>;
  sendAnswer(sdp: string): Promise<void>;
  sendIceCandidate(candidate: string): Promise<void>;
  onAnswer: ((sdp: string) => void) | null;
  onIceCandidate: ((candidate: string) => void) | null;
  close(): void;
}

export interface WebRtcShardTransferOptions {
  signalingChannel: SignalingChannel;
  peerConnectionConfig?: PeerConnectionConfig;
  peerConnectionFactory?: (config: RTCConfiguration) => RTCPeerConnection;
  shard: {
    transferId: string;
    fileId: string;
    versionNumber: number;
    shardIndex: number;
    data: Uint8Array;
    hash: string;
    targetNode?: string;
    sourceDevice?: string;
  };
  path?: "A" | "B";
  timeoutMs?: number;
  onProgress?: (bytesSent: number, totalBytes: number) => void;
}

export interface WebRtcShardTransferResult {
  path: "A" | "B";
  durationMs: number;
  transferId: string;
  bytesTransferred: number;
  ack: ShardAckPayload;
}

export class WebRtcTransferError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WebRtcTransferError";
    this.code = code;
  }
}

export class DataChannelIntegrityError extends WebRtcTransferError {
  constructor(message: string = "Shard BLAKE3 hash mismatch on DataChannel transfer") {
    super("INTEGRITY_MISMATCH", message);
    this.name = "DataChannelIntegrityError";
  }
}

export class DataChannelTimeoutError extends WebRtcTransferError {
  constructor(message: string = "DataChannel operation timed out") {
    super("TIMEOUT", message);
    this.name = "DataChannelTimeoutError";
  }
}
