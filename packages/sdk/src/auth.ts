//! Account auth client shared by web and native (Phase 7a opaque sessions).
//!
//! The SDK only speaks the Relay's logical paths. The platform adapter decides
//! whether that request rides a Next.js BFF proxy with the HttpOnly cookie
//! (web) or hits the Relay directly with a bearer session (native). No token,
//! JWT, or refresh credential is ever constructed here.

import type { RelayHttp } from "./adapters.js";

/**
 * Display-only platform metadata reported at login/register so the Devices list
 * can name the client ("iPhone · iOS 17", "Linux · Chrome 126", "Nodus 1.4
 * desktop"). Never used for authentication; each platform fills what it knows.
 */
export interface DeviceInfo {
  /** Coarse platform: "web", "ios", "android", "linux", "macos", "windows". */
  platform?: string;
  os_version?: string;
  /** Browser name/version for web clients. */
  browser?: string;
  /** Native app version, when not a browser. */
  app_version?: string;
  user_agent?: string;
}

/**
 * The public half of a device identity — enough to register/authenticate and
 * to be named in envelopes. The signing secret is a non-extractable handle
 * (ADR-0008) and is never part of this shape.
 */
export interface DevicePublicIdentity {
  device_id: string;
  public_key: string;
  /** Optional display metadata captured automatically at auth time. */
  info?: DeviceInfo;
}

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
  login(
    email: string,
    password: string,
    device: DevicePublicIdentity,
    encryptionPublicKey?: string,
  ): Promise<AuthResult>;
  register(
    email: string,
    password: string,
    device: DevicePublicIdentity,
    recoveryPublicKey?: string,
    encryptionPublicKey?: string,
  ): Promise<AuthResult>;
  logout(): Promise<void>;
  /** Current session, or null when missing/expired/revoked (Relay 401). */
  fetchSession(): Promise<SessionInfo | null>;
  /**
   * Change the account password. The Relay re-verifies `currentPassword`,
   * replaces the hash, and rotates the session (new id, old revoked) — so the
   * returned session supersedes any previously held cookie/token.
   */
  changePassword(currentPassword: string, newPassword: string): Promise<AuthResult>;
  /**
   * Sign out every other device: the Relay revokes all sessions for the account
   * and issues a fresh one for the calling device, returned as `session`.
   */
  logoutAll(): Promise<AuthResult>;
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
    login(email, password, device, encryptionPublicKey) {
      // device_id/public_key ride the login body so the Relay auto-registers
      // the device beside session creation (§2); no separate pairing step. The
      // X25519 encryption key (ADR-0008) is published here too, when present.
      return authenticate("/auth/login", {
        email,
        password,
        device_id: device.device_id,
        device_public_key: device.public_key,
        device_encryption_public_key: encryptionPublicKey,
        // Auto-captured by the platform; the Relay stores it for the Devices list.
        device_info: device.info,
      });
    },

    register(email, password, device, recoveryPublicKey, encryptionPublicKey) {
      return authenticate("/auth/register", {
        email,
        password,
        device_id: device.device_id,
        device_public_key: device.public_key,
        device_encryption_public_key: encryptionPublicKey,
        recovery_public_key: recoveryPublicKey,
        device_info: device.info,
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

    // Reuse `authenticate` so the BFF/Relay error body surfaces identically to
    // login/register, and a successful rotation returns the fresh session.
    changePassword(currentPassword, newPassword) {
      return authenticate("/auth/password", {
        current_password: currentPassword,
        new_password: newPassword,
      });
    },

    logoutAll() {
      return authenticate("/auth/logout-all", {});
    },
  };
}
