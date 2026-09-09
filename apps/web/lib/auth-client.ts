import type { StoredDeviceIdentity } from "@repo/relay-client";
import type { SessionInfo } from "./session";

// Thin client-side gateway to the /api/auth/* route handlers. The session
// itself lives in the HttpOnly cookie managed server-side; these helpers only
// return the §2 body (no token ever reaches the browser JS context).

export interface AuthResult {
  ok: boolean;
  error?: string;
  session?: SessionInfo;
}

async function postJson(path: string, body?: unknown): Promise<AuthResult> {
  const res = await fetch(path, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as Partial<SessionInfo> & { error?: string } | null;
  if (!res.ok) {
    return { ok: false, error: json?.error ?? "Request failed" };
  }
  return { ok: true, session: json as SessionInfo };
}

export async function login(email: string, password: string, device: StoredDeviceIdentity): Promise<AuthResult> {
  return postJson("/api/auth/login", {
    email,
    password,
    device_id: device.device_id,
    device_public_key: device.public_key,
  });
}

export async function register(email: string, password: string, device: StoredDeviceIdentity): Promise<AuthResult> {
  return postJson("/api/auth/register", {
    email,
    password,
    device_id: device.device_id,
    device_public_key: device.public_key,
  });
}

export async function logout(): Promise<void> {
  await postJson("/api/auth/logout");
}

export async function fetchSession(): Promise<SessionInfo | null> {
  const res = await fetch("/api/auth/session");
  if (!res.ok) {
    return null;
  }
  const json = (await res.json().catch(() => null)) as SessionInfo | null;
  return json;
}