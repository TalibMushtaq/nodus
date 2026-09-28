import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import { readJsonObject } from "../../../../lib/validate";
import { requireSession } from "../../../../lib/bff-guard";
import type { RelayError } from "../../../../lib/relay";

// DELETE /api/push/unsubscribe — removes a browser PushSubscription for the
// signed-in account so it stops receiving notifications.

export async function DELETE(request: Request) {
  const unauthorized = requireSession(request);
  if (unauthorized) return unauthorized;
  const body = await readJsonObject(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  if (typeof body.value.endpoint !== "string") {
    return NextResponse.json({ error: "missing endpoint" }, { status: 400 });
  }

  const { status, json } = await relayFetch<unknown>("/devices/web-push", {
    method: "DELETE",
    body: JSON.stringify({ endpoint: body.value.endpoint }),
  });
  if (status !== 200) {
    return NextResponse.json(
      { error: relayErrorMessage({ status, json: json as RelayError | null }) },
      { status },
    );
  }
  return NextResponse.json(json ?? { status: "ok" }, { status });
}
