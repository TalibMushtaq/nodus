import { redirect } from "next/navigation";

import type { SessionInfo } from "@repo/sdk";

import { relayFetch } from "./relay";

// The §2 session body is defined once in @repo/sdk so server and client (and
// native) cannot drift; re-exported here for existing importers.
export type { SessionInfo };

/**
 * Resolves the current session from the request cookie via the Relay. Null
 * when there is no session or it is expired/revoked (Relay returns 401).
 */
export async function getSession(): Promise<SessionInfo | null> {
  const { status, json } = await relayFetch<SessionInfo>("/auth/session");
  return status === 200 && json ? json : null;
}

/**
 * Guard for server components that must only render authenticated content.
 * Redirects to /auth when there is no valid session.
 */
export async function requireAuth(): Promise<SessionInfo> {
  const session = await getSession();
  if (!session) {
    redirect("/auth");
  }
  return session;
}