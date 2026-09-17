// Native implementation of the @repo/sdk platform adapters.
//
// Unlike the browser (which hides the session in an HttpOnly cookie managed by
// a Next.js BFF), the native app talks to the Relay origin directly and holds
// the opaque session ID in the OS keychain, presenting it as a bearer token.
// The Relay returns that ID in the login/register body only for
// `X-Nodus-Client: mobile`, so this adapter — the single platform boundary —
// captures it from the response and persists it for every later request.

import * as SecureStore from "expo-secure-store";
import type { RelayHttp, RelayRequestInit, RelayResponse, SecureStore as SecureStoreAdapter } from "@repo/sdk";

/** Operator-configured Relay origin; no default so first-run never guesses localhost. */
export const RELAY_BASE = (process.env.EXPO_PUBLIC_RELAY_URL ?? "").replace(/\/+$/, "");

/** Keychain entry holding the opaque session ID (never a JWT). */
export const SESSION_KEY = "nodus.relay.session";

/** expo-secure-store-backed SecureStore; also used for device identity. */
export const secureStore: SecureStoreAdapter = {
  get: (key) => SecureStore.getItemAsync(key),
  set: async (key, value) => {
    await SecureStore.setItemAsync(key, value);
  },
  // expo-secure-store may not have a value; deleting a missing key is a no-op.
  delete: (key) => SecureStore.deleteItemAsync(key),
};

/** In-memory mirror of the keychain session token (see currentSessionToken). */
let cachedToken: string | null = null;

export async function getSessionToken(): Promise<string | null> {
  const token = await secureStore.get(SESSION_KEY);
  cachedToken = token;
  return token;
}

/**
 * Synchronous mirror of the session token.
 *
 * The WebSocket factory is synchronous but must attach the bearer credential,
 * so the token is cached in memory whenever it is read or written. It holds
 * only the opaque session ID already resident in the keychain.
 */
export function currentSessionToken(): string | null {
  return cachedToken;
}

async function setSessionToken(token: string): Promise<void> {
  cachedToken = token;
  await secureStore.set(SESSION_KEY, token);
}

async function clearSessionToken(): Promise<void> {
  cachedToken = null;
  await secureStore.delete(SESSION_KEY);
}

/** Shape of the Relay auth response that carries the native session ID. */
interface AuthTokenBody {
  access_token?: string;
}

export function createNativeRelayHttp(): RelayHttp {
  return {
    async request<T = unknown>(path: string, init?: RelayRequestInit): Promise<RelayResponse<T>> {
      if (!RELAY_BASE) {
        // Fail loudly rather than silently targeting localhost: the operator
        // must set EXPO_PUBLIC_RELAY_URL (plan §3b).
        throw new Error("EXPO_PUBLIC_RELAY_URL is not configured");
      }

      const headers: Record<string, string> = { ...(init?.headers ?? {}) };
      // Identifies native so /auth/login returns the session ID in the body.
      headers["x-nodus-client"] = "mobile";
      const token = await getSessionToken();
      if (token) headers.authorization = `Bearer ${token}`;

      let body: BodyInit | undefined;
      if (init?.raw) {
        body = init.raw as unknown as BodyInit;
        headers["content-type"] ??= "application/octet-stream";
      } else if (init?.body !== undefined) {
        body = JSON.stringify(init.body);
        headers["content-type"] ??= "application/json";
      }

      const res = await fetch(`${RELAY_BASE}${path}`, {
        method: init?.method ?? "GET",
        headers,
        body,
        signal: init?.signal,
      });

      const text = await res.text();
      let json: T | undefined;
      let error: string | undefined;
      if (text) {
        try {
          const parsed = JSON.parse(text) as unknown;
          if (parsed && typeof parsed === "object" && "error" in parsed) {
            error = String((parsed as { error: unknown }).error);
          } else {
            json = parsed as T;
          }
        } catch {
          // Non-JSON body; status carries the outcome.
        }
      }

      // Capture the session ID on the auth responses that return it. Login,
      // register and recovery mint a session; password change and logout-all
      // rotate the caller's session too (the old id is revoked), so the fresh
      // token must replace the stored one. Logout is the only path that clears.
      const tokenPaths = [
        "/auth/login",
        "/auth/register",
        "/auth/recovery",
        "/auth/password",
        "/auth/logout-all",
      ];
      if (res.ok && tokenPaths.includes(path)) {
        const accessToken = (json as AuthTokenBody | undefined)?.access_token;
        if (accessToken) await setSessionToken(accessToken);
      } else if (path === "/auth/logout") {
        await clearSessionToken();
      }

      return { status: res.status, ok: res.ok, json, error };
    },
    publicRelayUrl: () => RELAY_BASE || null,
  };
}
