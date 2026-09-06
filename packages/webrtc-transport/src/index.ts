export {
  NodusRTCPeerConnection,
} from "./peer-connection.js";

export {
  CHUNK_SIZE,
  waitForChannelOpen,
  sendShard,
  receiveShard,
} from "./data-channel.js";

export {
  createLocalSignalingChannel,
  createRelaySignalingChannel,
} from "./signaling.js";
export type { LocalSignalingOptions } from "./signaling.js";

export {
  transferShardViaWebRtc,
} from "./transfer.js";

export {
  WebRtcTransferError,
  DataChannelIntegrityError,
  DataChannelTimeoutError,
} from "./types.js";

export type {
  PeerConnectionConfig,
  PeerConnectionEvents,
  PeerConnectionState,
  ShardSendOptions,
  ShardReceiveOptions,
  SignalingChannel,
  WebRtcShardTransferOptions,
  WebRtcShardTransferResult,
} from "./types.js";
