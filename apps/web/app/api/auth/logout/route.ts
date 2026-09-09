import { NextResponse } from "next/server";
import { relayFetch } from "../../../../lib/relay";
import type { RelayError } from "../../../../lib/relay";

export async function POST() {
  const { status, json, setCookie } = await relayFetch<RelayError>("/auth/logout", {
    method: "POST",
  });

  const res = NextResponse.json(
    json ?? { status: "logged out" },
    { status },
  );
  if (setCookie) {
    // Logout clears the macro-cookie client side (Max-Age=-1 from the Relay).
    res.headers.set("set-cookie", setCookie);
  }
  return res;
}