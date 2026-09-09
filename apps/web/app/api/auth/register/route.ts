import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";
import type { SessionInfo } from "../../../../lib/session";

export async function POST(request: Request) {
  const body = await request.text();

  const { status, json, setCookie } = await relayFetch<SessionInfo & RelayError>(
    "/auth/register",
    { method: "POST", body },
  );

  const res = NextResponse.json(
    status === 201 ? json : { error: relayErrorMessage({ status, json }) },
    { status },
  );
  if (setCookie) {
    res.headers.set("set-cookie", setCookie);
  }
  return res;
}