import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../lib/relay";
import type { RelayError } from "../../../lib/relay";

// GET /api/nodes — authenticated (session-cookie) proxy for the Relay's
// GET /nodes catalog, so the browser never constructs a Bearer header.

export async function GET() {
  const { status, json } = await relayFetch<unknown>("/nodes");
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}