import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";
import type { SessionInfo } from "../../../../lib/session";

// Password change is a privileged mutation: the Relay re-verifies the current
// password and rotates the session server-side. The BFF forwards the rotated
// Set-Cookie verbatim so the browser's HttpOnly cookie is the new session,
// matching login/register.
export async function POST(request: Request) {
  const body = await request.text();

  const { status, json, setCookie } = await relayFetch<SessionInfo & RelayError>(
    "/auth/password",
    { method: "POST", body },
  );

  const res = NextResponse.json(
    status === 200 ? json : { error: relayErrorMessage({ status, json }) },
    { status },
  );
  if (setCookie) {
    res.headers.set("set-cookie", setCookie);
  }
  return res;
}
