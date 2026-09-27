import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../../lib/relay";
import { requestHasSessionCookie } from "../../../../../lib/session-cookie";
import type { RelayError } from "../../../../../lib/relay";

// POST /api/nodes/{node_id}/ping — authenticated proxy for the Relay's manual
// reachability probe. The Relay pings the node over its WS connection and
// returns `{ online, rtt_ms?, reason? }`.

export async function POST(request: Request, { params }: { params: Promise<{ node_id: string }> }) {
  if (!requestHasSessionCookie(request)) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { node_id } = await params;
  const { status, json } = await relayFetch<unknown>(`/nodes/${encodeURIComponent(node_id)}/ping`, {
    method: "POST",
  });
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
