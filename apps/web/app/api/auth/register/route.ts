import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import { appendHardenedCookies } from "../../../../lib/session-cookie";
import type { RelayError } from "../../../../lib/relay";
import type { SessionInfo } from "../../../../lib/session";
import { readJsonObject } from "../../../../lib/validate";

export async function POST(request: Request) {
  // Reject malformed/oversized bodies before forwarding: the Relay still owns
  // credential/device validation, but the BFF must not buffer unbounded input.
  const body = await readJsonObject(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const { status, json, setCookies } = await relayFetch<SessionInfo & RelayError>(
    "/auth/register",
    { method: "POST", body: JSON.stringify(body.value) },
  );

  const res = NextResponse.json(
    status === 201 ? json : { error: relayErrorMessage({ status, json }) },
    { status },
  );
  appendHardenedCookies(res.headers, setCookies);
  return res;
}