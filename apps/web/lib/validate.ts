import "server-only";

// BFF request-shape guards.
//
// The Relay remains the authority on authentication, ownership, and business
// rules. These checks exist so an oversized or malformed request is rejected
// before the Next process buffers or forwards it — defense-in-depth against the
// BFF acting as a free memory amplifier, and a second line behind the Relay's
// own validation. They deliberately avoid re-encoding product rules (password
// policy, account rules), which must stay in one place: the Relay.

/** Cap for the small JSON bodies the auth/device/pairing proxies carry. */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

/** Cap for a proxied shard body: an 8 MiB shard plus envelope overhead. */
export const MAX_SHARD_BODY_BYTES = 12 * 1024 * 1024;

export type GuardFailure = { ok: false; status: number; error: string };
export type GuardSuccess<T> = { ok: true; value: T };

/** Reject early when the advertised Content-Length already exceeds the cap. */
function contentLengthTooLarge(request: Request, maxBytes: number): boolean {
  const header = request.headers.get("content-length");
  if (!header) return false;
  const size = Number(header);
  return Number.isFinite(size) && size > maxBytes;
}

/**
 * Read a JSON-object body with a size cap. `request.text()` still buffers, so
 * the cheap Content-Length pre-check runs first; the post-read length check
 * catches chunked bodies that omit the header. An empty body parses to `{}`.
 */
export async function readJsonObject(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<GuardSuccess<Record<string, unknown>> | GuardFailure> {
  if (contentLengthTooLarge(request, maxBytes)) {
    return { ok: false, status: 413, error: "request body too large" };
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, status: 400, error: "could not read request body" };
  }
  if (raw.length > maxBytes) {
    return { ok: false, status: 413, error: "request body too large" };
  }
  if (raw.trim() === "") {
    return { ok: true, value: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: "expected a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** True for a BLAKE3 hex digest (32 bytes → 64 hex chars). */
export function isBlake3Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

/** Maximum length accepted for a user-assigned device/node display name. */
export const MAX_DISPLAY_NAME_LENGTH = 120;

/**
 * Normalize a user-assigned display name. Returns the trimmed value with
 * control characters stripped, or null when the input is not a string or is
 * over the length cap. An empty string is valid (clears the name).
 */
export function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) return null;
  // Control characters would corrupt logs and terminal/JSON rendering.
  // Unicode property escape (not a literal control range) keeps no-control-regex happy.
  return trimmed.replace(/\p{Cc}/gu, "");
}

/** True when the string is a non-empty integer (used for shard metadata headers). */
export function isIntegerString(value: string | null): value is string {
  return value !== null && /^\d+$/.test(value);
}
