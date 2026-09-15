//! Account auth client shared by web and native (Phase 7a opaque sessions).
//!
//! The SDK only speaks the Relay's logical paths. The platform adapter decides
//! whether that request rides a Next.js BFF proxy with the HttpOnly cookie
//! (web) or hits the Relay directly with a bearer session (native). No token,
//! JWT, or refresh credential is ever constructed here.

import type { StoredDeviceIdentity } from "@repo/relay-client";
import type { RelayHttp } from "./adapters.js";

/** The locked §2 post-auth body. No token travels in the body. */
export interface SessionInfo {
  account_id: string;
  device_id: string;
  /** ISO-8601 UTC expiry of the current session. */
  session_expires_at: string;
  /** Account recovery Ed25519 public key (base64); null when not enrolled. */
  recovery_public_key?: string | null;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
  session?: SessionInfo;
}

export interface AuthClient {
  login(email: string, password: string, device: StoredDeviceIdentity): Promise<AuthResult>;
  register(
    email: string,
    password: string,
    device: StoredDeviceIdentity,
    recoveryPublicKey?: string,
  ): Promise<AuthResult>;
  logout(): Promise<void>;
  /** Current session, or null when missing/expired/revoked (Relay 401). */
  fetchSession(): Promise<SessionInfo | null>;
}

/**
 * Build an auth client over a platform Relay adapter. `ok` is derived from the
 * HTTP status rather than body shape so an unparseable success still counts.
 */
export function createAuthClient(http: RelayHttp): AuthClient {
  async function authenticate(path: string, body: unknown): Promise<AuthResult> {
    const res = await http.request<SessionInfo & { error?: string }>(path, { method: "POST", body });
    if (!res.ok) {
      return { ok: false, error: res.error ?? res.json?.error ?? "Request failed" };
    }
    return { ok: true, session: (res.json ?? undefined) as SessionInfo | undefined };
  }

  return {
    login(email, password, device) {
      // device_id/public_key ride the login body so the Relay auto-registers
      // the device beside session creation (§2); no separate pairing step.
      return authenticate("/auth/login", {
        email,
        password,
        device_id: device.device_id,
        device_public_key: device.public_key,
      });
    },

    register(email, password, device, recoveryPublicKey) {
      return authenticate("/auth/register", {
        email,
        password,
        device_id: device.device_id,
        device_public_key: device.public_key,
        recovery_public_key: recoveryPublicKey,
      });
    },

    async logout() {
      await http.request("/auth/logout", { method: "POST" });
    },

    async fetchSession() {
      // A transient network failure must read as "not authenticated yet", not
      // as an unhandled rejection: providers call this on every mount and on a
      // timer, and an offline client should simply stay signed-out-looking.
      let res;
      try {
        res = await http.request<SessionInfo>("/auth/session");
      } catch {
        return null;
      }
      if (!res.ok || !res.json) return null;
      return res.json;
    },
  };
}
