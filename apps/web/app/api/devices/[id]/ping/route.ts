import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../../lib/relay";
import { requestHasSessionCookie } from "../../../../../lib/session-cookie";
import type { RelayError } from "../../../../../lib/relay";

// POST /api/devices/{id}/ping — authenticated proxy for the Relay's manual
// reachability probe. The Relay pings the device over its WS connection and
// returns `{ online, rtt_ms?, reason? }`. A device without the Nodus web client
// open (e.g. an unbuilt mobile target) will time out rather than answer.

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!requestHasSessionCookie(request)) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;
  const { status, json } = await relayFetch<unknown>(`/devices/${encodeURIComponent(id)}/ping`, {
    method: "POST",
  });
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
