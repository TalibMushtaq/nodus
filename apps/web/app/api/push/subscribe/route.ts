import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import { readJsonObject } from "../../../../lib/validate";
import { requireSession } from "../../../../lib/bff-guard";
import type { RelayError } from "../../../../lib/relay";

// POST /api/push/subscribe — registers a browser PushSubscription with the
// Relay via the session-cookie proxy. The body is the browser's
// `PushSubscription.toJSON()` shape ({ endpoint, keys: { p256dh, auth } }).

export async function POST(request: Request) {
  const unauthorized = requireSession(request);
  if (unauthorized) return unauthorized;
  const body = await readJsonObject(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const { endpoint, keys } = body.value;
  if (typeof endpoint !== "string" || !keys || typeof keys !== "object") {
    return NextResponse.json({ error: "invalid subscription" }, { status: 400 });
  }

  const { status, json } = await relayFetch<unknown>("/devices/web-push", {
    method: "POST",
    body: JSON.stringify(body.value),
  });
  if (status !== 200) {
    return NextResponse.json(
      { error: relayErrorMessage({ status, json: json as RelayError | null }) },
      { status },
    );
  }
  return NextResponse.json(json ?? { status: "ok" }, { status });
}
