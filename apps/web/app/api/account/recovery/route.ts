import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";

// PUT /api/account/recovery — authenticated proxy for the Relay's
// PUT /account/recovery. Enrolls or rotates the account recovery public key
// (ADR-0002); the recovery phrase itself never leaves the browser.

export async function PUT(request: Request) {
  const body = await request.text();
  const { status, json } = await relayFetch<unknown>("/account/recovery", {
    method: "PUT",
    body,
  });
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
