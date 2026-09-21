"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { DevicePublicIdentity, DeviceSigner } from "@repo/sdk";

import { fetchSession, login, register, logout } from "../lib/auth-client";
import { getOrCreateDevice, getOrCreateEncryptionIdentity } from "../lib/device";
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
    getOrCreateDevice().then(({ identity, signer: s }) => {
      if (cancelled) return;
      setDevice(identity);
      setSigner(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    const sess = await fetchSession();
    setSession(sess);
    setStatus(sess ? "authenticated" : "unauthenticated");
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSession().then((sess) => {
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
    const res = await login(email, password, withInfo, getOrCreateEncryptionIdentity().public_key);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    setSession(res.session ?? null);
    setStatus("authenticated");
    return { ok: true, session: res.session ?? null };
  }, []);

  const handleRegister = useCallback(
    async (email: string, password: string, recoveryPublicKey?: string) => {
      const { identity } = await getOrCreateDevice();
      const encryptionKey = getOrCreateEncryptionIdentity().public_key;
      const withInfo = { ...identity, info: detectDeviceInfo() };
      // Only pass the recovery key when enrolling, so a plain registration keeps
      // its original call shape.
      const res = recoveryPublicKey
        ? await register(email, password, withInfo, recoveryPublicKey, encryptionKey)
        : await register(email, password, withInfo, undefined, encryptionKey);
      if (!res.ok) {
        return { ok: false, error: res.error };
      }
      setSession(res.session ?? null);
      setStatus("authenticated");
      return { ok: true, session: res.session ?? null };
    },
    [],
  );

  const handleLogout = useCallback(async () => {
    // Drop this browser's push subscription before the session is invalidated:
    // the DELETE proxy needs the cookie, and a shared browser must not keep
    // receiving the signed-out account's alerts.
    await removePushSubscriptionQuietly();
    await logout();
    setSession(null);
    setStatus("unauthenticated");
  }, []);

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