// Runtime Relay origin storage.
//
// The mobile app no longer takes its server URL from a build-time environment
// variable: the first launch asks for one and later launches load it from the
// OS keychain. Keeping it here (rather than in SQLite) means the background
// queue-drain task can hydrate it without opening the database. The value is
// cached in memory so synchronous callers (the WebSocket factory) and the HTTP
// adapter always see the current server after a settings change.

import * as SecureStore from "expo-secure-store";

import { normalizeRelayUrl } from "./relay-url";

const RELAY_URL_KEY = "nodus.relay.url";

/** In-memory mirror; empty until `loadRelayBase`/`saveRelayBase` runs. */
let currentRelayUrl = "";

/** Current Relay origin, or "" when the first-run screen has not saved one. */
export function getRelayBase(): string {
  return currentRelayUrl;
}

/**
 * Load the saved Relay origin into the in-memory cache.
 *
 * A corrupt or now-invalid value (for example a cleartext remote URL left by an
 * older build) is removed so the app falls back to the first-run prompt rather
 * than failing every request.
 */
export async function loadRelayBase(): Promise<string | null> {
  const stored = await SecureStore.getItemAsync(RELAY_URL_KEY);
  if (!stored) {
    currentRelayUrl = "";
    return null;
  }

  try {
    currentRelayUrl = normalizeRelayUrl(stored);
    return currentRelayUrl;
  } catch {
    currentRelayUrl = "";
    await SecureStore.deleteItemAsync(RELAY_URL_KEY).catch(() => undefined);
    return null;
  }
}

/**
 * Validate and persist a new Relay origin.
 *
 * The cache is updated only after the keychain write succeeds, so a failed
 * write cannot leave the running app pointing at a server that will not be
 * restored on the next launch.
 */
export async function saveRelayBase(input: string): Promise<string> {
  const normalized = normalizeRelayUrl(input);
  await SecureStore.setItemAsync(RELAY_URL_KEY, normalized);
  currentRelayUrl = normalized;
  return normalized;
}

/**
 * Best-effort reachability check before committing a new server.
 *
 * Any HTTP response proves the host is reachable; a wrong path or a degraded
 * Relay (503) is still a real server, and the sign-in request surfaces the
 * authoritative error. Only transport failures (DNS, TLS, timeout) reject.
 */
export async function probeRelay(base: string, timeoutMs = 5_000): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${base}/health`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch {
    throw new Error("Could not reach that server. Check the URL and your connection.");
  } finally {
    clearTimeout(timer);
  }
}
