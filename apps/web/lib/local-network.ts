// Browser capability detection for direct (WebRTC) transfers.
//
// Design decision D keeps the web client out of active mDNS discovery, so the
// browser only ever reaches a node through a known host (trusted-node cache) or
// the Relay. What still matters here is whether Path A/B can work at all:
//  - `RTCPeerConnection` must exist.
//  - Path A posts signaling to a node's plain-HTTP LAN port; an https page
//    cannot make that request (mixed content), so it is blocked in production.
//  - `EventSource` is needed for trickled local ICE candidates (Path A).
// When any of these fail the Transfer Manager must fall through to Path C/D
// rather than creating a half-negotiated peer connection.
//
// mDNS note: modern Chromium obfuscates host candidates as `<uuid>.local`.
// Those candidates are *correct* for same-LAN peers and must not be filtered
// out; if they cannot be resolved, ICE fails and the fallback chain handles it.

export interface WebRtcCapabilities {
  peerConnection: boolean;
  eventSource: boolean;
  secureContext: boolean;
  /** True when an https page would be blocked from posting to a plain-HTTP node. */
  mixedContentBlocksLocalHttp: boolean;
}

export function getWebRtcCapabilities(): WebRtcCapabilities {
  const peerConnection = typeof globalThis.RTCPeerConnection === "function";
  const eventSource = typeof globalThis.EventSource === "function";
  const secureContext = typeof globalThis.isSecureContext === "boolean" ? globalThis.isSecureContext : true;
  const pageIsHttps = typeof globalThis.location?.protocol === "string" && globalThis.location.protocol === "https:";
  return {
    peerConnection,
    eventSource,
    secureContext,
    // A node's local signaling endpoint is http://<lan-ip>:9378; only an http
    // page may call it. (This is why LAN transfer on https deployments needs
    // Path B or C.)
    mixedContentBlocksLocalHttp: pageIsHttps,
  };
}

/** Path A (local HTTP signaling + WebRTC) is usable only if all of these hold. */
export function canAttemptLocalPath(caps: WebRtcCapabilities = getWebRtcCapabilities()): boolean {
  return caps.peerConnection && caps.eventSource && !caps.mixedContentBlocksLocalHttp;
}

/** Path B (Relay signaling + WebRTC) needs only a peer connection. */
export function canAttemptRelaySignaling(caps: WebRtcCapabilities = getWebRtcCapabilities()): boolean {
  return caps.peerConnection;
}
