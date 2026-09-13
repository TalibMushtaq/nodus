import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../lib/relay";
import type { RelayError } from "../../../lib/relay";

// GET /api/folder-envelopes — authenticated (session-cookie) proxy for the
// Relay's bulk folder-key envelope list. One request returns every folder key
// the account holds, so the folder tree can decrypt all names at once.

export async function GET() {
  const { status, json } = await relayFetch<unknown>("/folder-envelopes");
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
