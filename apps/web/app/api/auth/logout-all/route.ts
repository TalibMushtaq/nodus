import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import { appendHardenedCookies } from "../../../../lib/session-cookie";
import type { RelayError } from "../../../../lib/relay";
import type { SessionInfo } from "../../../../lib/session";

// "Sign out everywhere": the Relay revokes all sessions for the account and
// issues a fresh one for this device. The returned Set-Cookie keeps the calling
// browser signed in while every other device is invalidated.
export async function POST() {
  const { status, json, setCookies } = await relayFetch<SessionInfo & RelayError>(
    "/auth/logout-all",
    { method: "POST" },
  );

  const res = NextResponse.json(
    status === 200 ? json : { error: relayErrorMessage({ status, json }) },
    { status },
  );
  appendHardenedCookies(res.headers, setCookies);
  return res;
}
