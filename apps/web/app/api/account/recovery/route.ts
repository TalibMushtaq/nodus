import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import { readRawBody } from "../../../../lib/validate";
import { requireSession } from "../../../../lib/bff-guard";
import type { RelayError } from "../../../../lib/relay";

// PUT /api/account/recovery — authenticated proxy for the Relay's
// PUT /account/recovery. Enrolls or rotates the account recovery public key
// (ADR-0002); the recovery phrase itself never leaves the browser.

export async function PUT(request: Request) {
  const unauthorized = requireSession(request);
  if (unauthorized) return unauthorized;
  const body = await readRawBody(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  const { status, json } = await relayFetch<unknown>("/account/recovery", {
    method: "PUT",
    body: body.value,
  });
  if (status !== 200) {
    return NextResponse.json({ error: relayErrorMessage({ status, json: json as RelayError | null }) }, { status });
  }
  return NextResponse.json(json, { status });
}
