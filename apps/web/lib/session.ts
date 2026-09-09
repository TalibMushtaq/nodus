import { redirect } from "next/navigation";
import { relayFetch } from "./relay";

/** The §2 session body the Relay returns for auth/session and login/register. */
export interface SessionInfo {
  account_id: string;
  device_id: string;
  /** ISO-8601 UTC expiry of the current session. */
  session_expires_at: string;
}

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