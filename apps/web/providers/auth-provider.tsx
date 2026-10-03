"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { DevicePublicIdentity, DeviceSigner } from "@repo/sdk";

import { fetchSession, login, register, logout } from "../lib/auth-client";
import { claimAccountScope, releaseAccountScope } from "../lib/account-scope";
import { clearEncryptionMemory, getOrCreateDevice, getOrCreateEncryptionIdentity } from "../lib/device";
import { clearFileKeys } from "../lib/keys";
import { clearRecoveryPhrase } from "../lib/recovery";
import { detectDeviceInfo } from "../lib/device-info";
import { removePushSubscriptionQuietly } from "../lib/web-push";
import type { SessionInfo } from "../lib/session";

// AuthProvider (re)auths against the Relay-backed session cookie on the
// client. The cookie is HttpOnly, so the browser never holds the token; the
// /api/auth/session route handler resolves it. State is bootstrapped in an
// effect (like the theme provider) to avoid SSR/hydration divergence.

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface AuthResult {
  ok: boolean;
  error?: string;
  /** The session minted by login/register, when the call succeeded. */
  session?: SessionInfo | null;
}

interface AuthContextValue {
  status: AuthStatus;
  session: SessionInfo | null;
  /** Public device identity (device_id + Ed25519 public key). */
  device: DevicePublicIdentity | null;
  /** Non-extractable signing handle for this device (ADR-0008). */
  signer: DeviceSigner | null;
  serverReachable: boolean;
  login: (email: string, password: string) => Promise<AuthResult>;
  /** `recoveryPublicKey` enrolls the account's ADR-0002 recovery identity. */
  register: (email: string, password: string, recoveryPublicKey?: string) => Promise<AuthResult>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [device, setDevice] = useState<DevicePublicIdentity | null>(null);
  const [signer, setSigner] = useState<DeviceSigner | null>(null);
  const [serverReachable, setServerReachable] = useState(true);

  // The device signing key is a non-extractable WebCrypto handle loaded after
  // SSR (browser-only); the identity/public half is the only persisted part.
  useEffect(() => {
    let cancelled = false;
    getOrCreateDevice().then(
      ({ identity, signer: s }) => {
        if (cancelled) return;
        setDevice(identity);
        setSigner(s);
      },
      // A WebCrypto/IndexedDB failure must not leave the app stuck in
      // "loading" forever with no device: fall back to unauthenticated so the
      // auth wizard renders and can surface a retry.
      () => {
        if (cancelled) return;
        setStatus("unauthenticated");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    const sess = await fetchSession();
    // Reconcile the local content stores to this account before exposing the
    // session, so a different account never reads the previous one's rows.
    if (sess) await claimAccountScope(sess.account_id).catch(() => undefined);
    setSession(sess);
    setStatus(sess ? "authenticated" : "unauthenticated");
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSession().then(async (sess) => {
      if (cancelled) return;
      if (sess) await claimAccountScope(sess.account_id).catch(() => undefined);
      if (cancelled) return;
      setSession(sess);
      setStatus(sess ? "authenticated" : "unauthenticated");
    });
    fetch("/api/health")
      .then((r) => r.json())
      .then((d: { ok: boolean }) => {
        if (!cancelled) setServerReachable(d.ok);
      })
      .catch(() => {
        if (!cancelled) setServerReachable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = useCallback(async (email: string, password: string) => {
    const { identity } = await getOrCreateDevice();
    // Attach the browser/OS fingerprint so the Relay can label this device in
    // the Devices list; it rides the existing device identity (display-only).
    const withInfo = { ...identity, info: detectDeviceInfo() };
    // Publish the X25519 encryption key alongside the Ed25519 identity so other
    // devices seal envelopes to it directly (ADR-0008).
    const encryption = await getOrCreateEncryptionIdentity();
    const res = await login(email, password, withInfo, encryption.public_key);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    const next = res.session ?? null;
    if (next) await claimAccountScope(next.account_id).catch(() => undefined);
    setSession(next);
    setStatus("authenticated");
    return { ok: true, session: next };
  }, []);

  const handleRegister = useCallback(
    async (email: string, password: string, recoveryPublicKey?: string) => {
      const { identity } = await getOrCreateDevice();
      const encryption = await getOrCreateEncryptionIdentity();
      const encryptionKey = encryption.public_key;
      const withInfo = { ...identity, info: detectDeviceInfo() };
      // Only pass the recovery key when enrolling, so a plain registration keeps
      // its original call shape.
      const res = recoveryPublicKey
        ? await register(email, password, withInfo, recoveryPublicKey, encryptionKey)
        : await register(email, password, withInfo, undefined, encryptionKey);
      if (!res.ok) {
        return { ok: false, error: res.error };
      }
      const next = res.session ?? null;
      if (next) await claimAccountScope(next.account_id).catch(() => undefined);
      setSession(next);
      setStatus("authenticated");
      return { ok: true, session: next };
    },
    [],
  );

  const handleLogout = useCallback(async () => {
    const accountId = session?.account_id ?? null;
    // Best-effort remote cleanup first, but never let a network failure skip the
    // local wipes below: otherwise the user appears signed out while the
    // account's decryption material stays on a shared browser.
    try {
      // Drop this browser's push subscription before the session is
      // invalidated: the DELETE proxy needs the cookie.
      await removePushSubscriptionQuietly();
      await logout();
    } catch {
      // Ignore: the local session is cleared in the finally regardless.
    } finally {
      // A shared browser must not keep a decryption oracle for the signed-out
      // account. This wipes account-scoped material only — the X25519 device
      // identity is kept, because deleting it would make this device publish a
      // new key and strand every envelope sealed to the old one.
      try {
        clearEncryptionMemory();
        await clearFileKeys();
      } catch {
        // Best-effort: a failed wipe must not block logout.
      }
      try {
        if (accountId) await clearRecoveryPhrase(accountId);
      } catch {
        // Best-effort: the Relay never holds the phrase.
      }
      // Revoke cached decrypted image previews (and their object URLs) so no
      // decrypted content for this account lingers. Imported lazily to avoid a
      // module cycle with preview.ts's useAuth import.
      try {
        const { revokeAllPreviews } = await import("../lib/preview");
        revokeAllPreviews();
      } catch {
        // Best-effort.
      }
      // Drop the account's local content (catalog, activity log, keys) so the
      // next sign-in on this browser starts clean. The device identity and the
      // sequence counter are kept — see clearLocalDatabase's keepSyncState.
      try {
        await releaseAccountScope();
      } catch {
        // Best-effort: a failed wipe must not block logout.
      }
      setSession(null);
      setStatus("unauthenticated");
    }
  }, [session]);

  const value = useMemo(
    () => ({
      status,
      session,
      device,
      signer,
      serverReachable,
      login: handleLogin,
      register: handleRegister,
      logout: handleLogout,
      refresh,
    }),
    [status, session, device, signer, serverReachable, handleLogin, handleRegister, handleLogout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}