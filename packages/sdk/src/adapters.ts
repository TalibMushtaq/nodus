//! Platform adapter contracts for @repo/sdk.
//!
//! The SDK owns all client-side logic that is identical on every platform
//! (auth, catalogue, envelopes, transfer orchestration). Anything that differs
//! — where credentials live, how bytes and databases are stored, how WebRTC is
//! created — is expressed here as an interface and injected by the host app.
//! This keeps browser-only APIs (IndexedDB, cookies, XMLHttpRequest) and
//! native-only APIs (expo-secure-store, expo-sqlite, react-native-webrtc) out
//! of the shared code.

/** A single Relay request expressed in SDK terms, not transport terms. */
export interface RelayRequestInit {
  method?: string;
  /** JSON body; the platform adapter serializes and sets content-type. */
  body?: unknown;
  /** Raw binary body (e.g. an encrypted shard); mutually exclusive with body. */
  raw?: Uint8Array;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Normalized Relay response. `error` mirrors the Relay's `{error}` body. */
export interface RelayResponse<T = unknown> {
  status: number;
  ok: boolean;
  json?: T;
  bytes?: Uint8Array;
  error?: string;
}

/**
 * The Relay HTTP boundary.
 *
 * `path` is always the logical Relay path (e.g. `/auth/login`) so services
 * never know whether they are talking to a Next.js BFF proxy (web, which keeps
 * the HttpOnly session cookie server-side) or the Relay origin directly
 * (native, which attaches its bearer session). The adapter owns all auth
 * attachment; SDK services never build credentials.
 */
export interface RelayHttp {
  request<T = unknown>(path: string, init?: RelayRequestInit): Promise<RelayResponse<T>>;
  /**
   * Operator-configured, user-facing Relay origin for pairing instructions.
   * `null` when the deployment did not set one — callers must not substitute
   * an internal/localhost URL (plan §3b/§7b).
   */
  publicRelayUrl(): string | null;
}

/**
 * Small, durable secret store. Backed by `localStorage` on web and
 * expo-secure-store (OS keychain/keystore) on native; values are opaque
 * strings so callers serialize their own JSON.
 */
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Connectivity signal used to drain the Path D queue when the Relay returns. */
export interface Connectivity {
  isRelayOnline(): boolean;
  /** Subscribe to Relay-connectivity transitions; returns an unsubscribe fn. */
  onRelayStatusChange(listener: (online: boolean) => void): () => void;
}
