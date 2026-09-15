// Moved to @repo/sdk so web and native share the signed relay-signaling
// channel; re-exported under the browser name existing callers/tests use.
export { createSignedRelayChannel as createBrowserRelayChannel } from "@repo/sdk";
export type { RelayChannelDeps as BrowserRelayChannelDeps } from "@repo/sdk";
