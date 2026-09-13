import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";

// PATCH /api/nodes/{node_id} — authenticated proxy for assigning (or clearing)
// a storage node's display name. The Relay is the source of truth; the client
// updates its catalog from the response.

export async function PATCH(request: Request, { params }: { params: Promise<{ node_id: string }> }) {
  const { node_id } = await params;
  const body = await request.text();
  const { status, json } = await relayFetch<unknown>(`/nodes/${encodeURIComponent(node_id)}`, {
    method: "PATCH",
    body,
  });
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
