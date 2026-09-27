import { NextResponse, type NextRequest } from "next/server";

import { crossOriginFailure } from "./lib/csrf";

// Edge middleware applying the CSRF guard to every BFF route. Centralizing it
// here means new mutating `/api` handlers are covered automatically rather than
// relying on each author to add the check. It is the front line only; the Relay
// remains the authority on authentication and ownership.
export function middleware(request: NextRequest) {
  const failure = crossOriginFailure(request);
  if (failure) {
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
