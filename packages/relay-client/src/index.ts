// Entry point for @repo/relay-client. Thin client layer shared by web and
// mobile: NodeClient speaks to a Storage Node's local HTTP listener
// (discovery/pair/auth), RelayWsClient speaks to the Relay's WebSocket
// gateway. Higher-level app logic (caching, mDNS) lives in the apps.

export {
  NODUS_LOCAL_PORT,
  NodeClient,
  NodeClientError,
  nodusBaseUrl,
  fetchAdvertisement,
  parsePairingUrl,
} from "./local-discovery.js";
export type { PairingUrlParts } from "./local-discovery.js";

export {
  createDeviceIdentity,
  deriveDeviceId,
  identityPrivateKey,
  identityPublicKey,
} from "./device-identity.js";
export type { StoredDeviceIdentity } from "./device-identity.js";

export { RelayWsClient, relayWsEndpoint } from "./ws-client.js";
export type { RelayWsHandlers, WsOutgoing } from "./ws-client.js";