//! @repo/sdk — the single client implementation shared by web and native.
//!
//! The SDK holds everything platform-agnostic (auth, device identity, and, as
//! the Phase 15 migration proceeds, catalogue/keys/envelopes/transfer logic).
//! Platform differences are injected through the adapter contracts in
//! `./adapters.js`; host apps (apps/web, apps/mobile) supply one adapter set
//! each. See docs/decisions/0007-mobile-native-and-sdk.md.

export type { RelayRequestInit, RelayResponse, RelayHttp, SecureStore, Connectivity } from "./adapters.js";

export { getOrCreateDeviceIdentity, isStoredDeviceIdentity, DEVICE_IDENTITY_KEY } from "./device.js";
export { createAuthClient } from "./auth.js";
export type { AuthClient, AuthResult, SessionInfo } from "./auth.js";

export { shortId, formatCountdown, formatBytes, timeAgo } from "./format.js";
export { isRelayOnline, relayStatusLabel } from "./connectivity.js";
export { createZip } from "./zip.js";
export type { ZipEntry } from "./zip.js";

export { createAttemptPath } from "./transfer/attempt-path.js";
export type { AttemptPathDeps, BufferedShardUpload } from "./transfer/attempt-path.js";
export { createSignedRelayChannel } from "./transfer/relay-signaling.js";
export type { RelayChannelDeps } from "./transfer/relay-signaling.js";
export { PersistentWebRtcSession, WebRtcSessionCache } from "./transfer/webrtc-session.js";
export type {
  PersistentSessionDeps,
  PersistentShardRequest,
  PersistentShardResult,
} from "./transfer/webrtc-session.js";
