import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import { hardenSessionCookie } from "../../../../lib/session-cookie";
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

  const { status, json, setCookie } = await relayFetch<SessionInfo & RelayError>(
    "/auth/register",
    { method: "POST", body: JSON.stringify(body.value) },
  );

  const res = NextResponse.json(
    status === 201 ? json : { error: relayErrorMessage({ status, json }) },
    { status },
  );
  if (setCookie) {
    res.headers.set("set-cookie", hardenSessionCookie(setCookie));
  }
  return res;
}