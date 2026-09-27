import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import { requestHasSessionCookie } from "../../../../lib/session-cookie";
import type { RelayError } from "../../../../lib/relay";
import { cleanDisplayName, readJsonObject } from "../../../../lib/validate";

// DELETE /api/devices/{id} — authenticated proxy for the Relay's
// DELETE /devices/{id}. Revoking wipes the device's key envelopes and every
// session bound to it, so the current browser only loses its session when it
// is the device being revoked.

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Refuse anonymous calls at the BFF: the Relay also authorizes the target,
  // but a missing session here can only be a forged/expired request.
  if (!requestHasSessionCookie(request)) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;
  const { status, json } = await relayFetch<unknown>(`/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}

// PATCH /api/devices/{id} — assign (or clear) this device's display name.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!requestHasSessionCookie(request)) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const { id } = await params;
  const body = await readJsonObject(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  const name = cleanDisplayName(body.value.name);
  if (name === null) {
    return NextResponse.json({ error: "name must be a string of at most 120 characters" }, { status: 400 });
  }
  const { status, json } = await relayFetch<unknown>(`/devices/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}