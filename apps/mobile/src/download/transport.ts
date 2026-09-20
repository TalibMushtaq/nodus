// Maps a download's transport onto the shared transfer-path vocabulary the
// PathIndicator understands. Kept in one place because both the activity log
// (which persists the path) and the Downloads screen (which renders it) need
// the same mapping.
//
// A LAN fetch and a WebRTC hop are both direct peer transfers, so both read as
// "Local P2P"; the relay proxy falls back to the Relay buffer label.

import type { DownloadTransport } from "@repo/sdk";
import type { TransferPath } from "@repo/transfer-manager";

export const DOWNLOAD_TRANSPORT_PATH: Record<DownloadTransport, TransferPath> = {
  lan: "local_signaling",
  relay: "buffer_relay",
  webrtc: "local_signaling",
};

export function downloadTransportPath(transport: DownloadTransport): TransferPath {
  return DOWNLOAD_TRANSPORT_PATH[transport];
}
