import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../lib/relay";
import type { RelayError } from "../../../lib/relay";

// GET /api/tombstones — authenticated proxy for the Relay's tombstone list
// (soft-deleted files/folders) that backs the Tombstone view.

export async function GET() {
  const { status, json } = await relayFetch<unknown>("/tombstones");
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
