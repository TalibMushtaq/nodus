// Small platform-neutral formatters for real (non-mock) entity ids and
// timestamps. Shared by web and native so both clients render identically.

import type { DeviceInfo } from "./auth.js";

/** Friendly names for the coarse platform tokens `detectDeviceInfo` emits. */
const PLATFORM_LABELS: Record<string, string> = {
  web: "Web",
  ios: "iOS",
  android: "Android",
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
  chromeos: "ChromeOS",
};

/**
 * One-line device descriptor for the Devices list, e.g. "Linux · Chrome 126",
 * "iOS 17.5 · Nodus 1.4", or null when nothing was ever reported (older
 * clients). Display-only; unknown platforms fall back to their raw token.
 */
export function describeDeviceInfo(info: DeviceInfo | null | undefined): string | null {
  if (!info) return null;
  const platform = info.platform?.trim().toLowerCase() ?? "";
  const os = info.os_version?.trim() ?? "";
  const platformPart = platform ? `${PLATFORM_LABELS[platform] ?? info.platform?.trim()}${os ? ` ${os}` : ""}` : os;
  const clientPart = info.browser?.trim() || (info.app_version?.trim() ? `Nodus ${info.app_version.trim()}` : "");
  const parts = [platformPart, clientPart].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** First `length` chars of a hex device/node id for compact display. */
export function shortId(id: string, length = 8): string {
  return id.length <= length ? id : `${id.slice(0, length)}…`;
}

/** `MM:SS` from a non-negative second count (used by the pairing-code countdown). */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Human-readable byte size (binary units). Null/negative render as an em dash. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes < 0) return "—";
  // Round sub-KB values: this formatter also renders transfer *rates*, which
  // decay through fractional bytes and would otherwise print full float
  // precision (e.g. "0.007043314722762237 B/s").
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Rough human-relative time from an ISO string ("just now", "3h ago").
 * The Relay only stores registration/revocation timestamps — there is no
 * per-device "last active" signal to show, so these read as the genuine times.
 */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
