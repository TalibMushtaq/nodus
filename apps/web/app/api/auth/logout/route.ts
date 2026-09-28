import { NextResponse } from "next/server";
import { relayFetch, relayErrorMessage } from "../../../../lib/relay";
import { appendHardenedCookies } from "../../../../lib/session-cookie";
import type { RelayError } from "../../../../lib/relay";

export async function POST() {
  const { status, json, setCookies } = await relayFetch<RelayError>("/auth/logout", {
    method: "POST",
  });

  // Derive the body from the status, not the raw shape: a Relay 5xx with an
  // empty body must not masquerade as a successful `{ status: "logged out" }`.
  const res = NextResponse.json(
    status === 200 ? (json ?? { status: "logged out" }) : { error: relayErrorMessage({ status, json }) },
    { status },
  );
  appendHardenedCookies(res.headers, setCookies);
  return res;
}