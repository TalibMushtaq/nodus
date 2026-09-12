"use client";

import { useEffect, useState } from "react";

import { getWebRtcCapabilities } from "./local-network";
import type { WebRtcCapabilities } from "./local-network";

/**
 * Resolve browser WebRTC capabilities after mount.
 *
 * `getWebRtcCapabilities` reads `window`/`RTCPeerConnection`, neither of which
 * exists during the server render. Computing it during render makes the server
 * HTML disagree with the first client render (e.g. the transfer-path banner
 * rendered on the server but not in the browser), which React reports as a
 * hydration mismatch. Starting from `null` and filling in on mount keeps the
 * server and first client pass identical, matching the theme/auth providers.
 */
export function useWebRtcCapabilities(): WebRtcCapabilities | null {
  const [capabilities, setCapabilities] = useState<WebRtcCapabilities | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate post-SSR bootstrap (same pattern as AuthProvider/ThemeProvider)
    setCapabilities(getWebRtcCapabilities());
  }, []);

  return capabilities;
}
