import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../lib/relay";
import type { RelayError } from "../../../lib/relay";

// GET /api/folders — authenticated (session-cookie) proxy for the Relay's
// GET /folders catalog. Feeds the browser's cached folder tree.

export async function GET() {
  const { status, json } = await relayFetch<unknown>("/folders");
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
