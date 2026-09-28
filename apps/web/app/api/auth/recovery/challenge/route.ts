import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../../lib/relay";
import { readRawBody } from "../../../../../lib/validate";
import type { RelayError } from "../../../../../lib/relay";

// POST /api/auth/recovery/challenge — unauthenticated proxy for the Relay's
// recovery nonce. The signed nonce is the recovery credential (ADR-0002).

export async function POST(request: Request) {
  // Public by design, but still capped so the BFF is not a body amplifier.
  const body = await readRawBody(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  const { status, json } = await relayFetch<unknown>("/auth/recovery/challenge", {
    method: "POST",
    body: body.value,
  });
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
