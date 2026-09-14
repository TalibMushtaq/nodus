import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../../lib/relay";
import type { RelayError } from "../../../../../lib/relay";

// POST /api/auth/recovery/challenge — unauthenticated proxy for the Relay's
// recovery nonce. The signed nonce is the recovery credential (ADR-0002).

export async function POST(request: Request) {
  const body = await request.text();
  const { status, json } = await relayFetch<unknown>("/auth/recovery/challenge", {
    method: "POST",
    body,
  });
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
