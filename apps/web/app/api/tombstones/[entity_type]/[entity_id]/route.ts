import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../../lib/relay";
import { requireSession } from "../../../../../lib/bff-guard";
import type { RelayError } from "../../../../../lib/relay";

// DELETE /api/tombstones/{entity_type}/{entity_id} — permanently purge a
// soft-deleted file/folder (Relay data + owning nodes).

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ entity_type: string; entity_id: string }> },
) {
  const unauthorized = requireSession(request);
  if (unauthorized) return unauthorized;
  const { entity_type, entity_id } = await params;
  const path = `/tombstones/${encodeURIComponent(entity_type)}/${encodeURIComponent(entity_id)}`;
  const { status, json } = await relayFetch<unknown>(path, { method: "DELETE" });
  if (status < 200 || status >= 300) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json ?? { status: "purged" }, { status });
}
