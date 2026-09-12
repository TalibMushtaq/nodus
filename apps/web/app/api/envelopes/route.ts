import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../lib/relay";
import type { RelayError } from "../../../lib/relay";

// GET /api/envelopes?file_id=... — authenticated proxy for the Relay's
// GET /envelopes. Returns opaque FEK envelopes; the client opens its own.

export async function GET(request: Request) {
  const fileId = new URL(request.url).searchParams.get("file_id");
  if (!fileId) {
    return NextResponse.json({ error: "file_id is required" }, { status: 400 });
  }
  const { status, json } = await relayFetch<unknown>(`/envelopes?file_id=${encodeURIComponent(fileId)}`);
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
