import type { ConnectionState } from "@repo/relay-client";

/**
 * Single source of truth for "is the Relay reachable right now".
 *
 * Only `connected` means traffic can flow. `connecting`/`reconnecting` are
 * transitional states where the socket is NOT usable — treating them as online
 * paints a green indicator while the Relay is actually unreachable, which
 * misleads users about whether sync is happening.
 */
export function isRelayOnline(status: ConnectionState): boolean {
  return status === "connected";
}

/** Short, user-facing label for the live Relay socket state. */
export function relayStatusLabel(status: ConnectionState): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "disconnected_max_retries":
      return "Offline";
    case "disconnected":
      return "Offline";
    default:
      return status;
  }
}
