import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";

// POST /api/push/subscribe — registers a browser PushSubscription with the
// Relay via the session-cookie proxy. The body is the browser's
// `PushSubscription.toJSON()` shape ({ endpoint, keys: { p256dh, auth } }).

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { endpoint?: unknown; keys?: unknown }
    | null;
  if (
    !body ||
    typeof body.endpoint !== "string" ||
    !body.keys ||
    typeof body.keys !== "object"
  ) {
    return NextResponse.json({ error: "invalid subscription" }, { status: 400 });
  }

  const { status, json } = await relayFetch<unknown>("/devices/web-push", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (status !== 200) {
    return NextResponse.json(
      { error: relayErrorMessage({ status, json: json as RelayError | null }) },
      { status },
    );
  }
  return NextResponse.json(json ?? { status: "ok" }, { status });
}
