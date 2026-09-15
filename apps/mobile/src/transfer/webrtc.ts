// Native peer-connection factory for the shared transfer chain.
//
// RN has no global `RTCPeerConnection`; react-native-webrtc provides one. The
// SDK's NodusRTCPeerConnection accepts a `customFactory`, so we hand back the
// native constructor and keep the shared signaling/session logic unchanged.
//
// Data channels only — no media tracks — so the app does not need camera or
// microphone access.

import { RTCPeerConnection as NativeRTCPeerConnection } from "react-native-webrtc";

/** Binds react-native-webrtc's RTCPeerConnection to the DOM-typed SDK factory. */
export function createNativePeerConnectionFactory(): (
  config: RTCConfiguration,
) => RTCPeerConnection {
  return (config) =>
    new NativeRTCPeerConnection(config as never) as unknown as RTCPeerConnection;
}
