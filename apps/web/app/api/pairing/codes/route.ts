import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";

// POST /api/pairing/codes — authenticated proxy for the Relay's
// POST /pairing/codes. The Relay mints a one-time NODUS-XXXX-XXXX code and
// returns it exactly once with its expiry; the plaintext is never stored.
// The session cookie authenticates the account server-side via relayFetch.

export async function POST(request: Request) {
  const body = await request.text();

  const { status, json } = await relayFetch<unknown>("/pairing/codes", {
    method: "POST",
    body,
  });

  // Pass a successful mint through as-is; the Relay currently returns 201, but
  // accept any 2xx so a status tweak does not turn a valid code into an error.
  const ok = status >= 200 && status < 300;
  return NextResponse.json(
    ok ? json : { error: relayErrorMessage({ status, json: json as RelayError | null }) },
    { status },
  );
}
