import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";

// GET /api/envelopes/summary — authenticated proxy for the Relay's
// GET /envelopes/summary. Returns per-recipient envelope coverage (counts and
// last-updated) for the Security page; carries no ciphertext.

export async function GET() {
  const { status, json } = await relayFetch<unknown>("/envelopes/summary");
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
