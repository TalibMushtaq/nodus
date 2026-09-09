import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";

// POST /api/devices/register — authenticated proxy for the Relay's
// POST /devices/register (ownership-safe device upsert). Used by /pair before
// issuing a pairing token, so the device row exists and binds the token.

export async function POST(request: Request) {
  const body = await request.text();

  const { status, json } = await relayFetch<unknown>("/devices/register", {
    method: "POST",
    body,
  });

  const res = NextResponse.json(
    status === 201 ? json : { error: relayErrorMessage({ status, json: json as RelayError | null }) },
    { status },
  );
  return res;
}