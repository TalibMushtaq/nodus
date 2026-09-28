import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import { appendHardenedCookies } from "../../../../lib/session-cookie";
import { readRawBody } from "../../../../lib/validate";
import type { RelayError } from "../../../../lib/relay";
import type { SessionInfo } from "../../../../lib/session";

// POST /api/auth/recovery — unauthenticated proxy for the Relay's recovery
// endpoint. On success it forwards the Set-Cookie that starts the session.

export async function POST(request: Request) {
  // Public by design, but still capped so the BFF is not a body amplifier.
  const body = await readRawBody(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  const { status, json, setCookies } = await relayFetch<SessionInfo & RelayError>("/auth/recovery", {
    method: "POST",
    body: body.value,
  });

  const res = NextResponse.json(
    status === 200 ? json : { error: relayErrorMessage({ status, json }) },
    { status },
  );
  appendHardenedCookies(res.headers, setCookies);
  return res;
}
