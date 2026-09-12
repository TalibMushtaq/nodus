"use client";

import { PathIndicator } from "@repo/ui/primitives/path-indicator";
import type { TransferPath } from "@repo/ui/primitives/path-indicator";

import { isRelayOnline } from "../lib/connectivity";
import { useWebRtcCapabilities } from "../lib/use-capabilities";
import { useWs } from "../providers/ws-provider";

/**
 * Non-blocking status banner shown when direct peer transfer is unavailable in
 * this browser (no WebRTC, or an https page that cannot reach a node's plain
 * HTTP LAN port). Transfers still work — they fall back to the Relay buffer —
 * so this informs rather than blocks, matching the inline/quiet error style
 * used elsewhere in the app.
 */
export function TransferPathBanner() {
  const { status } = useWs();
  // Capabilities are browser-only; the hook yields null until mount so the
  // server and first client render agree (avoids a hydration mismatch).
  const caps = useWebRtcCapabilities();

  if (!caps) return null;

  const directUnavailable = !caps.peerConnection || caps.mixedContentBlocksLocalHttp;
  if (!directUnavailable) return null;

  // Reconnecting is not "buffered": the buffer write path is down with the
  // socket, so only a live connection should claim files are being buffered.
  const path: TransferPath = isRelayOnline(status) ? "buffered" : "offline";

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
    >
      <PathIndicator path={path} />
      <span>
        Direct device-to-device transfer isn&apos;t available here, so files use the Relay
        buffer (delivered when a Storage Node is online).
      </span>
    </div>
  );
}
