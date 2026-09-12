import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../lib/relay";
import type { RelayError } from "../../../lib/relay";

// GET /api/files — authenticated (session-cookie) proxy for the Relay's
// GET /files catalog. Feeds the browser's IndexedDB catalog cache; the client
// never constructs a Bearer header.

export async function GET() {
  const { status, json } = await relayFetch<unknown>("/files");
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
