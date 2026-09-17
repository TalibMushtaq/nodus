import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";

// DELETE /api/push/unsubscribe — removes a browser PushSubscription for the
// signed-in account so it stops receiving notifications.

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (!body || typeof body.endpoint !== "string") {
    return NextResponse.json({ error: "missing endpoint" }, { status: 400 });
  }

  const { status, json } = await relayFetch<unknown>("/devices/web-push", {
    method: "DELETE",
    body: JSON.stringify({ endpoint: body.endpoint }),
  });
  if (status !== 200) {
    return NextResponse.json(
      { error: relayErrorMessage({ status, json: json as RelayError | null }) },
      { status },
    );
  }
  return NextResponse.json(json ?? { status: "ok" }, { status });
}
