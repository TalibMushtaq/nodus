// Best-effort client fingerprint sent with login/register so the Devices list
// can name a browser ("Linux · Chrome 126") without the user labelling it. This
// is display-only metadata, never used for authentication, and the parser is a
// pure function so it can be unit-tested without a DOM.

import type { DeviceInfo } from "@repo/sdk";

/** Map a Windows NT kernel version to its marketing name (best effort). */
function windowsVersion(nt: string): string {
  switch (nt) {
    case "10.0":
      return "10/11";
    case "6.3":
      return "8.1";
    case "6.2":
      return "8";
    case "6.1":
      return "7";
    default:
      return nt;
  }
}

/**
 * Parse a user-agent (plus an optional `navigator.userAgentData.platform` hint,
 * which is the modern, less-spoofable source on Chromium) into display fields.
 * Falls back to sensible defaults rather than throwing on an unknown agent.
 */
export function parseUserAgent(ua: string, platformHint = ""): DeviceInfo {
  // Browser: order matters — every Chromium agent also contains "Chrome", and
  // Safari's agent contains neither, so the most specific token is checked first.
  let browser = "Browser";
  let version: string | undefined;
  const match = (re: RegExp) => ua.match(re)?.[1];
  if (ua.includes("Edg/")) {
    browser = "Edge";
    version = match(/Edg\/([\d.]+)/);
  } else if (ua.includes("OPR/") || ua.includes("Opera/")) {
    browser = "Opera";
    version = match(/OPR\/([\d.]+)/) ?? match(/Opera\/([\d.]+)/);
  } else if (ua.includes("Firefox/")) {
    browser = "Firefox";
    version = match(/Firefox\/([\d.]+)/);
  } else if (ua.includes("Chrome/") || ua.includes("CriOS/")) {
    browser = "Chrome";
    version = match(/Chrome\/([\d.]+)/) ?? match(/CriOS\/([\d.]+)/);
  } else if (ua.includes("Safari/")) {
    browser = "Safari";
    version = match(/Version\/([\d.]+)/);
  }

  // Platform + OS version: derive from the agent, falling back to the hint.
  let platform = platformHint.trim().toLowerCase();
  let osVersion: string | undefined;
  if (/Android/i.test(ua)) {
    platform = "android";
    osVersion = match(/Android ([\d.]+)/);
  } else if (/iPhone|iPad|iPod/i.test(ua)) {
    platform = "ios";
    osVersion = match(/OS (\d+[_.\d]*)/)?.replace(/_/g, ".");
  } else if (/Windows/i.test(ua)) {
    platform = "windows";
    const nt = match(/Windows NT ([\d.]+)/);
    if (nt) osVersion = windowsVersion(nt);
  } else if (/Mac OS X/i.test(ua)) {
    platform = "macos";
    osVersion = match(/Mac OS X (\d+[_.\d]*)/)?.replace(/_/g, ".");
  } else if (/CrOS/i.test(ua)) {
    platform = "chromeos";
  } else if (/Linux/i.test(ua)) {
    platform = "linux";
  } else if (!platform) {
    platform = "web";
  }

  const browserLabel = version ? `${browser} ${version.split(".")[0]}` : browser;
  return {
    platform,
    os_version: osVersion,
    browser: browserLabel,
    user_agent: ua.slice(0, 256),
  };
}

/** Read the browser globals and produce the device metadata to report. */
export function detectDeviceInfo(): DeviceInfo {
  if (typeof navigator === "undefined") return { platform: "web" };
  const ua = navigator.userAgent ?? "";
  const hint =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "";
  return parseUserAgent(ua, hint);
}
