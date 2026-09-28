import { NextResponse } from "next/server";
import { relayFetchRaw } from "../../../../lib/relay";
import { MAX_SHARD_BODY_BYTES, isBlake3Hex, isIntegerString } from "../../../../lib/validate";
import { requireSession } from "../../../../lib/bff-guard";

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
  // Reject anonymous uploads before touching the stream: the shard is
  // account-scoped, and the guard keeps the proxy from being an open relay.
  const unauthorized = requireSession(request);
  if (unauthorized) return unauthorized;
  // Catch an oversized shard before the stream is opened: a shard is 8 MiB, so
  // anything past the cap is malformed or hostile and must not be proxied.
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_SHARD_BODY_BYTES) {
    return NextResponse.json({ error: "shard body too large" }, { status: 413 });
  }
  // Validate the metadata the Relay parses so an invalid shard never leaves the
  // BFF (the Relay still re-validates; this is the cheap front door).
  const fileId = request.headers.get("x-nodus-file-id");
  const targetNode = request.headers.get("x-nodus-target-node");
  const transferId = request.headers.get("x-nodus-transfer-id");
  const hash = request.headers.get("x-nodus-hash");
  const versionNumber = request.headers.get("x-nodus-version-number");
  const shardIndex = request.headers.get("x-nodus-shard-index");
  const size = request.headers.get("x-nodus-size");
  if (
    !fileId ||
    !targetNode ||
    !transferId ||
    !isBlake3Hex(hash) ||
    !isIntegerString(versionNumber) ||
    !isIntegerString(shardIndex) ||
    !isIntegerString(size)
  ) {
    return NextResponse.json({ error: "invalid shard metadata" }, { status: 400 });
  }

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
