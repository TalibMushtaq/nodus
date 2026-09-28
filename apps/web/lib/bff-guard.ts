import { NextResponse } from "next/server";

import { requestHasSessionCookie } from "./session-cookie";

/**
 * Cheap pre-filter for mutating BFF routes: reject requests that carry no
 * session cookie before they reach the Relay.
 *
 * This is not authentication. `requestHasSessionCookie` only checks for the
 * cookie's presence, so a forged or expired value still passes; the Relay
 * remains the authority on identity and ownership. What this buys is that
 * anonymous traffic cannot use the Next process as a free body buffer or an
 * unauthenticated proxy into the Relay, and it matches the intent of the
 * routes that already guard this way.
 *
 * Returns null when the request may proceed.
 */
export function requireSession(request: Request): Response | null {
  if (requestHasSessionCookie(request)) return null;
  return NextResponse.json({ error: "authentication required" }, { status: 401 });
}
