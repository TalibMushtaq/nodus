import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";
import type { SessionInfo } from "../../../../lib/session";

// POST /api/auth/recovery — unauthenticated proxy for the Relay's recovery
// endpoint. On success it forwards the Set-Cookie that starts the session.

export async function POST(request: Request) {
  const body = await request.text();
  const { status, json, setCookie } = await relayFetch<SessionInfo & RelayError>("/auth/recovery", {
    method: "POST",
    body,
  });

  const res = NextResponse.json(
    status === 200 ? json : { error: relayErrorMessage({ status, json }) },
    { status },
  );
  if (setCookie) {
    res.headers.set("set-cookie", setCookie);
  }
  return res;
}
