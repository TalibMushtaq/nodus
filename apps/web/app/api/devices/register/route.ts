import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";

// POST /api/devices/register — authenticated proxy for the Relay's
// POST /devices/register (ownership-safe device upsert). Used to enroll an
// additional device on the account before it can be paired with a node: the
// device row must exist so the pairing session can resolve its public key.
//
// This route was removed as "unused" by the web UI, but the Path C E2E harness
// (scripts/e2e-path-c.sh) registers its second device through it, and without
// it that device never appears in GET /devices — so no key envelope is sealed
// for it and its download fails with MissingEnvelopeError.

export async function POST(request: Request) {
  const body = await request.text();

  const { status, json } = await relayFetch<unknown>("/devices/register", {
    method: "POST",
    body,
  });

  return NextResponse.json(
    status === 201 ? json : { error: relayErrorMessage({ status, json: json as RelayError | null }) },
    { status },
  );
}
