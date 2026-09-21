// A tiny indirection letting non-hook modules (e.g. `lib/ping.ts`) issue a
// presence query over the Relay socket the `WsProvider` owns. The provider
// registers a bridge while it has a live socket and clears it on unmount, so
// callers fall back to the HTTP endpoints when the socket is unavailable.
//
// This keeps reachability probes on the existing socket instead of an HTTP hop
// per probe, without turning every non-React caller into a hook.

export interface PresenceBridge {
  /** Send a presence_query envelope over the Relay socket. */
  send: (message: { type: string; payload: unknown }) => void;
  /** Subscribe to a message type; returns an unsubscribe function. */
  subscribe: (type: string, handler: (payload: unknown) => void) => () => void;
  /** True only while the socket is open, so callers can prefer the WS path. */
  isConnected: () => boolean;
}

let bridge: PresenceBridge | null = null;

export function setPresenceBridge(next: PresenceBridge | null): void {
  bridge = next;
}

export function getPresenceBridge(): PresenceBridge | null {
  return bridge;
}
