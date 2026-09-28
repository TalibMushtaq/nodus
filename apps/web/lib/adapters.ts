// Web implementation of the @repo/sdk platform adapters.
//
// The browser never holds the session: requests go to the Next.js BFF under
// /api/*, which attaches the HttpOnly `nodus_session` cookie server-side (see
// lib/relay.ts). The SDK only knows logical Relay paths, so this adapter is the
// one place that maps them to the browser-facing proxy.

import type { RelayHttp, RelayRequestInit, RelayResponse } from "@repo/sdk";

export function createWebRelayHttp(): RelayHttp {
  return {
    async request<T = unknown>(path: string, init?: RelayRequestInit): Promise<RelayResponse<T>> {
      const headers: Record<string, string> = { ...(init?.headers ?? {}) };
      let body: BodyInit | undefined;
      if (init?.raw) {
        body = init.raw as unknown as BodyInit;
        headers["content-type"] ??= "application/octet-stream";
      } else if (init?.body !== undefined) {
        body = JSON.stringify(init.body);
        headers["content-type"] ??= "application/json";
      }

      const res = await fetch(`/api${path}`, {
        method: init?.method ?? "GET",
        headers,
        body,
        signal: init?.signal,
      });

      // Parse defensively: success bodies and `{error}` failures share routes,
      // and a 204/empty body must not throw.
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
          // Non-JSON body; leave json/error undefined and let status speak.
        }
      }

      return { status: res.status, ok: res.ok, json, error };
    },
    // The public Relay URL is resolved server-side for the pairing UI; a client
    // adapter has no safe way to know it and must not guess localhost (§3b).
    publicRelayUrl: () => null,
  };
}
