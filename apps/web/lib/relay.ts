import "server-only";

import { cookies } from "next/headers";

// Server-only HTTP boundary to the Relay. The Relay sets the session as an
// HttpOnly cookie during login/register; route handlers forward that Set-Cookie
// verbatim so one nodus_session value is shared between the Next app, the /ws
// gateway, and the Relay itself (all on localhost in dev, same domain in prod).

export const RELAY_SESSION_COOKIE = "nodus_session";

/** Server-side Relay base URL; overridable for remote/prod deployments. */
export function relayUrl(): string {
  return process.env.RELAY_URL ?? "http://localhost:8080";
}

export interface RelayResult<T> {
  status: number;
  json: T | null;
  /** The Relay's raw Set-Cookie header to forward, if any. */
  setCookie: string | null;
}

/**
 * Calls the Relay with the current request's session cookie attached. Returns
 * the status, parsed JSON, and the Relay's Set-Cookie header verbatim.
 */
export async function relayFetch<T>(path: string, init?: RequestInit): Promise<RelayResult<T>> {
  const sessionCookie = (await cookies()).get(RELAY_SESSION_COOKIE)?.value;

  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (sessionCookie) {
    headers.set("cookie", `${RELAY_SESSION_COOKIE}=${sessionCookie}`);
  }

  try {
    const res = await fetch(`${relayUrl()}${path}`, { ...init, headers });
    const setCookie = res.headers.get("set-cookie");
    const json = (await res.json().catch(() => null)) as T | null;
    return { status: res.status, json, setCookie };
  } catch {
    return { status: 503, json: null, setCookie: null };
  }
}

/** Error body shape returned by the Relay on non-2xx auth responses. */
export interface RelayError {
  error?: string;
}

export function relayErrorMessage(res: { status: number; json: RelayError | null }): string {
  return res.json?.error ?? "Relay request failed";
}