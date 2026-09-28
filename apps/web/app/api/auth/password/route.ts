import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import { appendHardenedCookies } from "../../../../lib/session-cookie";
import { readRawBody } from "../../../../lib/validate";
import { requireSession } from "../../../../lib/bff-guard";
import type { RelayError } from "../../../../lib/relay";
import type { SessionInfo } from "../../../../lib/session";

// Password change is a privileged mutation: the Relay re-verifies the current
// password and rotates the session server-side. The BFF forwards the rotated
// Set-Cookie verbatim so the browser's HttpOnly cookie is the new session,
// matching login/register.
export async function POST(request: Request) {
  const unauthorized = requireSession(request);
  if (unauthorized) return unauthorized;
  // Cap the body before buffering: this route is authenticated, but the BFF
  // must not be a free memory amplifier for a malformed request.
  const body = await readRawBody(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const { status, json, setCookies } = await relayFetch<SessionInfo & RelayError>(
    "/auth/password",
    { method: "POST", body: body.value },
  );

  const res = NextResponse.json(
    status === 200 ? json : { error: relayErrorMessage({ status, json }) },
    { status },
  );
  appendHardenedCookies(res.headers, setCookies);
  return res;
}
