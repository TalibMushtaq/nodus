import { NextResponse } from "next/server";
import { relayFetch } from "../../../../lib/relay";
import type { SessionInfo } from "../../../../lib/session";

export async function GET() {
  const { status, json } = await relayFetch<SessionInfo>("/auth/session");
  return NextResponse.json(
    status === 200 ? json : { error: "unauthorized" },
    { status },
  );
}