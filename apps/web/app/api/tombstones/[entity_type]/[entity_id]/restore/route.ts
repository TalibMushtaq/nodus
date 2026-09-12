import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../../../lib/relay";
import type { RelayError } from "../../../../../../lib/relay";

// POST /api/tombstones/{entity_type}/{entity_id}/restore — undo a soft delete.
// Clears the tombstone so the file/folder reappears in the catalog and its
// retained node data is no longer purged at the original deadline.

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ entity_type: string; entity_id: string }> },
) {
  const { entity_type, entity_id } = await params;
  const path = `/tombstones/${encodeURIComponent(entity_type)}/${encodeURIComponent(entity_id)}/restore`;
  const { status, json } = await relayFetch<unknown>(path, { method: "POST" });
  if (status < 200 || status >= 300) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json ?? {}, { status });
}
