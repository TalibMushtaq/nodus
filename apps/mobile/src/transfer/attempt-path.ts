// Native binding for the shared @repo/sdk attempt-path chain.
//
// Supplies the platform-specific pieces: the react-native-webrtc peer
// connection factory, the LAN trusted-node host lookup from SQLite, the Relay
// buffer poster, Path B signaling over the native Relay socket, and the device
// Ed25519 signer the node verifies for direct sessions.

import {
  createAttemptPath,
  createSignedRelayChannel,
  type WebRtcSessionCache,
} from "@repo/sdk";
import {
  identityPrivateKey,
  signDeviceMessage,
  type StoredDeviceIdentity,
} from "@repo/relay-client";
import type { AttemptPathFn, LocalQueue } from "@repo/transfer-manager";

import { getTrustedNodes } from "../store/trusted-nodes";
import { postShard } from "./buffer";
import { createNativePeerConnectionFactory } from "./webrtc";

/** Minimal Relay socket surface the attempt path needs (satisfied by MobileWs). */
export interface MobileRelaySocket {
  send: (type: string, payload: unknown) => void;
  on: (type: string, handler: (payload: unknown) => void) => () => void;
  isConnected: () => boolean;
}

export interface MobileAttemptPathDeps {
  device: StoredDeviceIdentity;
  localQueue: LocalQueue;
  relay: MobileRelaySocket;
  /** Share persistent WebRTC sessions across shards; the app owns the cache. */
  sessionCache?: WebRtcSessionCache;
  /**
   * Whether local (Path A) transfers may run. Defaults to always-allowed; the
   * app passes an AppState-backed predicate so Path A stays foreground-only
   * (ADR-0004).
   */
  canAttemptLocal?: () => boolean;
}

export function createMobileAttemptPath(deps: MobileAttemptPathDeps): AttemptPathFn {
  // One signer for both Path A (LAN) and Path B (relay): the node checks that
  // the offer/ICE came from the device it paired with.
  const sign = (message: string) => signDeviceMessage(identityPrivateKey(deps.device), message);

  return createAttemptPath({
    postShard,
    localQueue: deps.localQueue,
    deviceId: deps.device.device_id,
    sourceDevice: deps.device.device_id,
    signLocal: sign,
    createRelayChannel: (targetNode) =>
      createSignedRelayChannel({
        // The SDK channel takes an envelope; adapt to MobileWs's (type, payload).
        send: (msg) => deps.relay.send(msg.type, msg.payload),
        on: deps.relay.on,
        fromPeer: deps.device.device_id,
        toPeer: targetNode,
        sign,
      }),
    isRelayAvailable: deps.relay.isConnected,
    sessionCache: deps.sessionCache,
    resolveLocalHost: async (nodeId) =>
      (await getTrustedNodes()).find((n) => n.node_id === nodeId)?.host ?? null,
    // Native has no mixed-content rule and always ships a peer connection, but
    // Path A is gated on the app being foregrounded (ADR-0004).
    canAttemptLocalPath: () => deps.canAttemptLocal?.() ?? true,
    canAttemptRelaySignaling: () => true,
    peerConnectionFactory: createNativePeerConnectionFactory(),
  });
}
