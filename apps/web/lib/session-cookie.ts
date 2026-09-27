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
  if (!lower.some((part) => part.startsWith("samesite="))) parts.push("SameSite=Lax");
  if (process.env.NODE_ENV === "production" && !lower.includes("secure")) parts.push("Secure");
  return parts.join("; ");
}

/** True when the incoming request carries a Relay session cookie. */
export function requestHasSessionCookie(request: Request): boolean {
  const cookie = request.headers.get("cookie");
  return (
    cookie !== null &&
    cookie.split(";").some((part) => part.trim().startsWith(`${RELAY_SESSION_COOKIE}=`))
  );
}
