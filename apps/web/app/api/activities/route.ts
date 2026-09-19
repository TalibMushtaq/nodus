import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../lib/relay";
import type { RelayError } from "../../../lib/relay";

// GET /api/activities — authenticated (session-cookie) proxy for the Relay's
// account-wide activity feed. The browser never constructs a Bearer header;
// when the Relay is unreachable the client falls back to a paired Storage Node
// over the LAN.

export async function GET(request: Request) {
  const limit = new URL(request.url).searchParams.get("limit") ?? "200";
  const { status, json } = await relayFetch<unknown>(
    `/activities?limit=${encodeURIComponent(limit)}`,
  );
  if (status !== 200) {
    return NextResponse.json(
      { error: relayErrorMessage({ status, json: json as RelayError | null }) },
      { status },
    );
  }
  return NextResponse.json(json, { status });
}
