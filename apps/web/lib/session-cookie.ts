// Session-cookie helpers for the BFF.
//
// Kept free of `next/headers`/`server-only` so route tests can exercise the
// pure cookie logic without a Next request context.

import { RELAY_SESSION_COOKIE } from "./relay";

/**
 * Normalize the Relay's Set-Cookie before forwarding it to the browser.
 *
 * The Relay already sets a session cookie, but the BFF is the last hop, so it
 * asserts the baseline flags that make the cookie safe: `HttpOnly` (no JS
 * access), `SameSite=Lax` (blocks the cross-site form/fetch CSRF class), and —
 * in production only, to avoid breaking plain-http localhost dev — `Secure`.
 * Attributes already present are left untouched.
 */
export function hardenSessionCookie(setCookie: string): string {
  const parts = setCookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const lower = parts.map((part) => part.toLowerCase());
  if (!lower.includes("httponly")) parts.push("HttpOnly");
  // SameSite=None is the cross-site exposure this hardening exists to prevent,
  // so overwrite it rather than merely defaulting when absent. Strict is kept.
  const sameSiteIndex = lower.findIndex((part) => part.startsWith("samesite="));
  if (sameSiteIndex === -1) {
    parts.push("SameSite=Lax");
  } else if (lower[sameSiteIndex] === "samesite=none") {
    parts[sameSiteIndex] = "SameSite=Lax";
  }
  // A missing Path would scope the cookie to the request directory.
  if (!lower.some((part) => part.startsWith("path="))) parts.push("Path=/");
  if (process.env.NODE_ENV === "production" && !lower.includes("secure")) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Forward each Relay Set-Cookie, hardened, as a separate header. Appending
 * (not setting) preserves multiple cookies; a single joined value would be
 * malformed once split again.
 */
export function appendHardenedCookies(headers: Headers, setCookies: string[]): void {
  for (const cookie of setCookies) {
    headers.append("set-cookie", hardenSessionCookie(cookie));
  }
}

/** True when the incoming request carries a Relay session cookie. */
export function requestHasSessionCookie(request: Request): boolean {
  const cookie = request.headers.get("cookie");
  return (
    cookie !== null &&
    cookie.split(";").some((part) => part.trim().startsWith(`${RELAY_SESSION_COOKIE}=`))
  );
}
