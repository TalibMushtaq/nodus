import { NextResponse } from "next/server";
import { relayFetch } from "../../../lib/relay";

export async function GET() {
  const { status } = await relayFetch("/health");
  return NextResponse.json({ ok: status === 200 }, { status });
}
