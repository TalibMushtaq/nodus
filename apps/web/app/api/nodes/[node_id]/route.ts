import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";
import { cleanDisplayName, readJsonObject } from "../../../../lib/validate";

// PATCH /api/nodes/{node_id} — authenticated proxy for assigning (or clearing)
// a storage node's display name. The Relay is the source of truth; the client
// updates its catalog from the response.

export async function PATCH(request: Request, { params }: { params: Promise<{ node_id: string }> }) {
  const { node_id } = await params;
  const body = await readJsonObject(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  const name = cleanDisplayName(body.value.name);
  if (name === null) {
    return NextResponse.json({ error: "name must be a string of at most 120 characters" }, { status: 400 });
  }
  const { status, json } = await relayFetch<unknown>(`/nodes/${encodeURIComponent(node_id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
