// Small client-side formatters for real (non-mock) entity ids and timestamps.

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