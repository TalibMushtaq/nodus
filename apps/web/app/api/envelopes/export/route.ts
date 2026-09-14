import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";

// GET /api/envelopes/export — authenticated proxy for the Relay's
// GET /envelopes/export. Returns every opaque envelope for the account so the
// Security page can offer an offline ciphertext-only backup.

export async function GET() {
  const { status, json } = await relayFetch<unknown>("/envelopes/export");
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
