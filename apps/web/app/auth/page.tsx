"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/primitives/icons";

import { useAuth } from "../../providers/auth-provider";
import { getOrCreateDeviceIdentity } from "../../lib/device";
import {
  createRecoveryPhrase,
  isValidPhrase,
  materializeRecoveryKeys,
  recoverAccount,
  recoveryPublicKey,
  saveRecoveryPhrase,
} from "../../lib/recovery";

// Auth wizard. Two credential paths:
//  - password: email → password (register inserts a recovery-phrase step so the
//    ADR-0002 phrase is shown once and its public key enrolled), or
//  - recovery: email → phrase, which signs a Relay nonce and starts a session
//    on this fresh device without a password.
// On submit the device identity (id + Ed25519 public key) rides along; the route
// handler sets the HttpOnly session cookie, then we land on the dashboard.

type AuthStep = "email" | "password" | "recovery" | "phrase";
type AuthMode = "signin" | "register" | "recover";

export default function AuthPage() {
  const router = useRouter();
  const { login, register, refresh, status, serverReachable } = useAuth();

  const [step, setStep] = useState<AuthStep>("email");
  const [mode, setMode] = useState<AuthMode>("signin");
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The freshly generated recovery phrase and the user's acknowledgement that
  // they stored it. Held in state so a failed registration does not lose it.
  const [recoveryPhrase, setRecoveryPhrase] = useState("");
  const [recoverySaved, setRecoverySaved] = useState(false);
  // Phrase typed by the user during recovery login.
  const [recoveryInput, setRecoveryInput] = useState("");

  // Already signed in (client-side navigation onto /auth): bounce to the
  // dashboard once the session resolves.
  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/overview");
    }
  }, [status, router]);

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setStep("email");
    setError(null);
    setPassword("");
    setRecoveryInput("");
  };

  const handleContinue = async () => {
    setError(null);

    if (step === "email") {
      if (!email.includes("@")) {
        setError("Enter a valid email");
        return;
      }
      setStep(mode === "recover" ? "phrase" : "password");
      return;
    }

    if (step === "phrase") {
      const normalized = recoveryInput.trim();
      if (!normalized) {
        setError("Enter your recovery phrase");
        return;
      }
      if (!isValidPhrase(normalized)) {
        setError("That doesn't look like a valid 24-word recovery phrase");
        return;
      }
      setLoading(true);
      try {
        const dev = getOrCreateDeviceIdentity();
        const res = await recoverAccount(email, normalized, dev);
        if (!res.ok) {
          setError(res.error ?? "Recovery failed");
          return;
        }
        // Unlock this device's keys from the recovery envelopes and keep the
        // phrase locally so Security can reveal it later.
        try {
          await materializeRecoveryKeys(normalized);
        } catch {
          // Non-fatal: account access succeeded; downloads fall back to envelopes.
        }
        if (res.session?.account_id) {
          await saveRecoveryPhrase(res.session.account_id, normalized);
        }
        await refresh();
        router.push("/overview");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Recovery failed");
      } finally {
        setLoading(false);
      }
      return;
    }

    // Only registration imposes the 8-character policy; sign-in must accept a
    // pre-existing password of any length or legacy accounts cannot log in.
    if (mode === "register" && password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password.length === 0) {
      setError("Enter your password");
      return;
    }

    // Register: mint the recovery phrase and show it before creating anything,
    // so the user records it while the account is being enrolled.
    if (mode === "register" && step === "password") {
      setRecoveryPhrase(createRecoveryPhrase());
      setRecoverySaved(false);
      setStep("recovery");
      return;
    }

    if (step === "recovery" && !recoverySaved) {
      setError("Confirm you have saved your recovery phrase");
      return;
    }

    setLoading(true);
    const res =
      mode === "register"
        ? await register(email, password, recoveryPublicKey(recoveryPhrase))
        : await login(email, password);
    setLoading(false);

    if (!res.ok) {
      setError(res.error ?? "Authentication failed");
      return;
    }

    // Keep the phrase locally (same store as file keys) so Security can reveal
    // it later; the Relay only ever received the derived public key.
    if (mode === "register" && res.session?.account_id) {
      await saveRecoveryPhrase(res.session.account_id, recoveryPhrase);
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
            Server unreachable — sign-in won&apos;t work until the relay is back online.
          </div>
        )}

        <div className="bg-card border border-border p-6 space-y-5">
          {/* Header */}
          <div>
            <h1 className="text-sm font-semibold text-foreground">
              {mode === "register" && step === "email" && "Create your account"}
              {mode === "register" && step === "password" && "Choose a password"}
              {mode === "register" && step === "recovery" && "Save your recovery phrase"}
              {mode === "signin" && step === "email" && "Welcome back"}
              {mode === "signin" && step === "password" && "Enter your password"}
              {mode === "recover" && step === "email" && "Recover your account"}
              {mode === "recover" && step === "phrase" && "Enter your recovery phrase"}
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              {step === "email"
                ? mode === "register"
                  ? "Sign up to sync your files across devices"
                  : mode === "recover"
                    ? "Use your offline recovery phrase to sign in on this device"
                    : "Sign in to sync your files across devices"
                : step === "recovery"
                  ? "The only way to recover your files if you lose every device"
                  : step === "phrase"
                    ? `For ${email}`
                    : `For ${email}`}
            </p>
          </div>

          {/* Fields */}
          {step === "email" && (
            <>
              <input
                type="email"
                placeholder="you@example.com"
                aria-label="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputCls}
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleContinue()}
              />
              {mode === "recover" ? (
                <button
                  type="button"
                  onClick={() => switchMode("signin")}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  ← Back to sign in
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setMode(mode === "signin" ? "register" : "signin")}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {mode === "signin" ? "Don't have an account? Create one" : "Already have an account? Sign in"}
                  </button>
                  <button
                    type="button"
                    onClick={() => switchMode("recover")}
                    className="block text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Lost your devices? Use a recovery key
                  </button>
                </>
              )}
            </>
          )}
          {step === "password" && (
            <>
              <input
                type="password"
                placeholder="Password"
                aria-label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleContinue()}
              />
              {/* Recover from a typo'd email without reloading the wizard. */}
              <button
                type="button"
                onClick={() => {
                  setStep("email");
                  setPassword("");
                  setError(null);
                }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                ← Use a different email
              </button>
            </>
          )}
          {step === "phrase" && (
            <>
              <textarea
                placeholder="Enter your 24-word recovery phrase"
                aria-label="Recovery phrase"
                value={recoveryInput}
                onChange={(e) => setRecoveryInput(e.target.value)}
                rows={3}
                className={`${inputCls} font-mono resize-none`}
                autoFocus
              />
              <button
                type="button"
                onClick={() => {
                  setStep("email");
                  setRecoveryInput("");
                  setError(null);
                }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                ← Use a different email
              </button>
            </>
          )}
          {step === "recovery" && (
            <>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 p-3 bg-secondary border border-border rounded-lg">
                {recoveryPhrase.split(" ").map((word, index) => (
                  <div key={`${word}-${index}`} className="flex items-baseline gap-1.5 text-xs font-mono text-foreground">
                    <span className="text-muted-foreground w-4 text-right shrink-0">{index + 1}</span>
                    <span className="truncate">{word}</span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-amber-700 dark:text-amber-300">
                Write these 24 words down in order and keep them offline. Anyone with this phrase can
                access your account, and Nodus cannot restore it for you.
              </p>
              <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={recoverySaved}
                  onChange={(e) => setRecoverySaved(e.target.checked)}
                  className="mt-0.5"
                />
                I have saved my recovery phrase somewhere safe.
              </label>
            </>
          )}

          {/* Error */}
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}

          {/* Continue */}
          <button
            type="button"
            onClick={handleContinue}
            disabled={loading || !serverReachable}
            title={!serverReachable ? "The relay is unreachable" : undefined}
            className="w-full py-2.5 text-sm font-medium bg-accent text-accent-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading
              ? "Please wait..."
              : step === "email"
                ? "Continue"
                : step === "phrase"
                  ? "Recover account"
                  : mode === "register"
                    ? step === "recovery"
                      ? "I've saved it — create account"
                      : "Continue"
                    : "Sign in"}
          </button>
        </div>

        <p className="text-center text-[10px] text-muted-foreground mt-4">
          Nodus &middot; End-to-end encrypted peer-to-peer file sync
        </p>
      </div>
    </main>
  );
}
