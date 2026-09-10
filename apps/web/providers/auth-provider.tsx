"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import { fetchSession, login, register, logout } from "../lib/auth-client";
import { getOrCreateDeviceIdentity } from "../lib/device";
import type { SessionInfo } from "../lib/session";

// AuthProvider (re)auths against the Relay-backed session cookie on the
// client. The cookie is HttpOnly, so the browser never holds the token; the
// /api/auth/session route handler resolves it. State is bootstrapped in an
// effect (like the theme provider) to avoid SSR/hydration divergence.

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface AuthResult {
  ok: boolean;
  error?: string;
}

interface AuthContextValue {
  status: AuthStatus;
  session: SessionInfo | null;
  device: StoredDeviceIdentity | null;
  serverReachable: boolean;
  login: (email: string, password: string) => Promise<AuthResult>;
  register: (email: string, password: string) => Promise<AuthResult>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [device, setDevice] = useState<StoredDeviceIdentity | null>(null);
  const [serverReachable, setServerReachable] = useState(true);

  // Device identity is generated lazily in the browser only (localStorage).
  // Same hydration justification as the theme provider: browser-only state
  // must be read after SSR in an effect, not during render.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate post-SSR bootstrap
    setDevice(getOrCreateDeviceIdentity());
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
    const dev = getOrCreateDeviceIdentity();
    const res = await login(email, password, dev);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    setSession(res.session ?? null);
    setStatus("authenticated");
    return { ok: true };
  }, []);

  const handleRegister = useCallback(async (email: string, password: string) => {
    const dev = getOrCreateDeviceIdentity();
    const res = await register(email, password, dev);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    setSession(res.session ?? null);
    setStatus("authenticated");
    return { ok: true };
  }, []);

  const handleLogout = useCallback(async () => {
    await logout();
    setSession(null);
    setStatus("unauthenticated");
  }, []);

  const value = useMemo(
    () => ({
      status,
      session,
      device,
      serverReachable,
      login: handleLogin,
      register: handleRegister,
      logout: handleLogout,
      refresh,
    }),
    [status, session, device, serverReachable, handleLogin, handleRegister, handleLogout, refresh],
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