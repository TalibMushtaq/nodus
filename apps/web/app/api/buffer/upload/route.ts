import { NextResponse } from "next/server";
import { relayFetchRaw } from "../../../../lib/relay";

// POST /api/buffer/upload — Path C shard proxy. The browser posts the raw
// encrypted shard here with `X-Nodus-*` metadata; this forwards the body and
// headers to the Relay's `POST /buffer/upload` with the HttpOnly session
// cookie attached on the server. Streaming the request body through avoids
// buffering the whole 8 MB shard in the Next process.

export const runtime = "nodejs";

/** Only the shard-metadata headers the Relay's parseUploadMetadata reads. */
const FORWARD_HEADERS = [
  "x-nodus-file-id",
  "x-nodus-version-number",
  "x-nodus-shard-index",
  "x-nodus-hash",
  "x-nodus-size",
  "x-nodus-target-node",
  "x-nodus-transfer-id",
  "x-nodus-source-device",
] as const;

export async function POST(request: Request) {
  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("content-type", request.headers.get("content-type") ?? "application/octet-stream");

  try {
    const res = await relayFetchRaw("/buffer/upload", {
      method: "POST",
      headers,
      body: request.body,
      // Required by undici when the body is a stream; ignored by browsers.
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const body = (await res.json().catch(() => null)) as unknown;
    if (body === null) {
      return NextResponse.json({ error: "relay returned a non-JSON response" }, { status: res.status });
    }
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ error: "relay unreachable" }, { status: 503 });
  }
}
