import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";
import { readJsonObject } from "../../../../lib/validate";

// POST /api/pairing/sessions — authenticated proxy for the Relay's
// POST /pairing/sessions (issues a device-bound token and WS-pushes it to the
// node). The session cookie authenticates the account server-side.

export async function POST(request: Request) {
  const body = await readJsonObject(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const { status, json } = await relayFetch<unknown>("/pairing/sessions", {
    method: "POST",
    body: JSON.stringify(body.value),
  });

  const res = NextResponse.json(
    status === 201 ? json : { error: relayErrorMessage({ status, json: json as RelayError | null }) },
    { status },
  );
  return res;
}