import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";
import type { SessionInfo } from "../../../../lib/session";

// "Sign out everywhere": the Relay revokes all sessions for the account and
// issues a fresh one for this device. The returned Set-Cookie keeps the calling
// browser signed in while every other device is invalidated.
export async function POST() {
  const { status, json, setCookie } = await relayFetch<SessionInfo & RelayError>(
    "/auth/logout-all",
    { method: "POST" },
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
