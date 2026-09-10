"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/primitives/icons";

import { useAuth } from "../../providers/auth-provider";

// Phase 7a §3 auth wizard (AuthFlow). Two-step email → password, with a
// sign-in / create-account toggle. Real auth: on submit the device identity
// (id + Ed25519 public key) is passed alongside credentials, the route handler
// proxies to the Relay and sets the HttpOnly session cookie, then we land on
// the dashboard. No more mock setTimeout / localStorage "nodus-session" flag.

type AuthStep = "email" | "password";
type AuthMode = "signin" | "register";

export default function AuthPage() {
  const router = useRouter();
  const { login, register, status, serverReachable } = useAuth();

  const [step, setStep] = useState<AuthStep>("email");
  const [mode, setMode] = useState<AuthMode>("signin");
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Already signed in (client-side navigation onto /auth): bounce to the
  // dashboard once the session resolves.
  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/overview");
    }
  }, [status, router]);

  const handleContinue = async () => {
    setError(null);

    if (step === "email") {
      if (!email.includes("@")) {
        setError("Enter a valid email");
        return;
      }
      setStep("password");
      return;
    }

    if (password.length < 8) {
      setError(mode === "register" ? "Password must be at least 8 characters" : "Enter your password");
      return;
    }

    setLoading(true);
    const res = mode === "register" ? await register(email, password) : await login(email, password);
    setLoading(false);

    if (!res.ok) {
      setError(res.error ?? "Authentication failed");
      return;
    }

    router.push("/overview");
  };

  const inputCls = "w-full px-4 py-3 text-sm bg-secondary border border-border text-foreground placeholder-muted-foreground outline-none focus:border-accent transition-colors";

  return (
    <main className="min-h-dvh flex items-center justify-center bg-gradient-to-br from-orange-100 via-orange-50 to-amber-100 dark:from-stone-950 dark:via-stone-950 dark:to-stone-900">
      <div className="w-full max-w-sm mx-4">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <span className="text-accent"><Icon name="logo" size={22} /></span>
          <span className="text-lg font-semibold tracking-tight text-foreground">Nodus</span>
        </div>

        {!serverReachable && (
          <div className="mb-4 px-4 py-2.5 text-xs text-center rounded-lg" style={{ color: "var(--status-offline)", backgroundColor: "var(--status-offline-bg)", border: "1px solid var(--status-offline)30" }}>
            Server unreachable — sign-in won&#39;t work until the relay is back online.
          </div>
        )}

        <div className="bg-card border border-border p-6 space-y-5">
          {/* Header */}
          <div>
            <h1 className="text-sm font-semibold text-foreground">
              {mode === "register" && step === "email" && "Create your account"}
              {mode === "register" && step === "password" && "Choose a password"}
              {mode === "signin" && step === "email" && "Welcome back"}
              {mode === "signin" && step === "password" && "Enter your password"}
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              {step === "email"
                ? mode === "register"
                  ? "Sign up to sync your files across devices"
                  : "Sign in to sync your files across devices"
                : `For ${email}`}
            </p>
          </div>

          {/* Fields */}
          {step === "email" && (
            <>
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputCls}
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleContinue()}
              />
              <button
                type="button"
                onClick={() => setMode(mode === "signin" ? "register" : "signin")}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {mode === "signin" ? "Don't have an account? Create one" : "Already have an account? Sign in"}
              </button>
            </>
          )}
          {step === "password" && (
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputCls}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleContinue()}
            />
          )}

          {/* Error */}
          {error && <p className="text-xs text-destructive">{error}</p>}

          {/* Continue */}
          <button
            type="button"
            onClick={handleContinue}
            disabled={loading}
            className="w-full py-2.5 text-sm font-medium bg-accent text-accent-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading ? "Please wait..." : step === "email" ? "Continue" : mode === "register" ? "Create account" : "Sign in"}
          </button>
        </div>

        <p className="text-center text-[10px] text-muted-foreground mt-4">
          Nodus &middot; End-to-end encrypted peer-to-peer file sync
        </p>
      </div>
    </main>
  );
}