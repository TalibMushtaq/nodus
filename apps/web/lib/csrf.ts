// Cross-site request forgery guard for the BFF.
//
// The session lives in an HttpOnly cookie, so a cross-site page cannot read it
// but *can* still ride it: a form or fetch to `/api/*` from another origin would
// be sent with the browser's cookie attached. Modern browsers label the request
// with `Sec-Fetch-Site`; this module refuses `cross-site` outright and, for
// older clients that omit it, compares `Origin` (or `Referer`) against the Host
// the browser addressed. Requests with neither header are allowed: non-browser
// callers (the e2e harness, curl) do not send them, and the HttpOnly cookie plus
// Relay-side authorization still apply.
//
// Pure header inspection, so it is safe to import from the edge middleware.

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface CrossOriginFailure {
  status: number;
  error: string;
}

/** Returns a failure when a state-changing request is not same-origin. */
export function crossOriginFailure(request: Request): CrossOriginFailure | null {
  if (!MUTATING_METHODS.has(request.method)) return null;

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return { status: 403, error: "cross-site request rejected" };
  }

  const source = request.headers.get("origin") ?? request.headers.get("referer");
  if (!source) return null;

  let sourceHost: string;
  try {
    sourceHost = new URL(source).host;
  } catch {
    return { status: 403, error: "invalid request origin" };
  }

  // Prefer the Host header: request.url may be rewritten by the reverse proxy,
  // while Host is what the browser actually addressed.
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (sourceHost !== host) {
    return { status: 403, error: "cross-origin request rejected" };
  }
  return null;
}
