import { NextResponse } from "next/server";
import { relayFetchRaw } from "../../../../lib/relay";
import { isBlake3Hex } from "../../../../lib/validate";
import { requireSession } from "../../../../lib/bff-guard";

// GET /api/shard/{hash} — design A shard download proxy. The browser asks the
// Relay for the raw bytes of a NODE_STORED shard; the Relay pulls it from the
// account's node over its authenticated WS connection. The HttpOnly session
// cookie is attached server-side, and the payload is streamed straight through
// so an 8 MB shard is never buffered whole in the Next process.

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  // A shard hash is a BLAKE3 digest; reject anything else before proxying so
  // the route cannot be used to fetch arbitrary Relay paths.
  if (!isBlake3Hex(hash)) {
    return NextResponse.json({ error: "invalid shard hash" }, { status: 400 });
  }
  // The shard is account-scoped; require a session so the route cannot be used
  // to make the Relay pull shards for anonymous callers.
  const unauthorized = requireSession(request);
  if (unauthorized) return unauthorized;

  try {
    const res = await relayFetchRaw(`/shards/${encodeURIComponent(hash)}`, { method: "GET" });
    if (!res.ok) {
      let error = `relay shard fetch failed: ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) error = body.error;
      } catch {
        // Non-JSON error body; keep the HTTP status message.
      }
      return NextResponse.json({ error }, { status: res.status });
    }

    return new NextResponse(res.body, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      },
    });
  } catch {
    return NextResponse.json({ error: "relay unreachable" }, { status: 503 });
  }
}