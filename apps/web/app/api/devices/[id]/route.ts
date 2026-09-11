import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";

// DELETE /api/devices/{id} — authenticated proxy for the Relay's
// DELETE /devices/{id}. Revoking wipes the device's key envelopes and every
// session bound to it, so the current browser only loses its session when it
// is the device being revoked.

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { status, json } = await relayFetch<unknown>(`/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}