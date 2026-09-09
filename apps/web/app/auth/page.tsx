"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/primitives/icons";

// Mock auth wizard. No real auth wired yet — clicking "Continue" sets a
// fake localStorage flag and redirects to /overview after a simulated delay.
// This page is NOT a server component because it uses useState + localStorage.

type AuthStep = "email" | "password" | "totp" | "done";

export default function AuthPage() {
  const router = useRouter();
  const [step, setStep] = useState<AuthStep>("email");
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState<string | null>(null);

  const fakeDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const handleContinue = async () => {
    setError(null);
    setLoading(true);
    await fakeDelay(800);

    if (step === "email") {
      if (!email.includes("@")) { setError("Enter a valid email"); setLoading(false); return; }
      setStep("password");
    } else if (step === "password") {
      if (password.length < 4) { setError("Password too short"); setLoading(false); return; }
      setStep("totp");
    } else if (step === "totp") {
      if (totp.length !== 6) { setError("Enter 6-digit code"); setLoading(false); return; }
      setStep("done");
      await fakeDelay(400);
      localStorage.setItem("nodus-session", "mock");
      router.push("/overview");
    }
    setLoading(false);
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

        <div className="bg-card border border-border p-6 space-y-5">
          {/* Header */}
          <div>
            <h1 className="text-sm font-semibold text-foreground">
              {step === "email" && "Welcome back"}
              {step === "password" && "Enter your password"}
              {step === "totp" && "Two-factor authentication"}
              {step === "done" && "Signing in..."}
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              {step === "email" && "Sign in to sync your files across devices"}
              {step === "password" && `For ${email}`}
              {step === "totp" && "Enter the 6-digit code from your authenticator app"}
              {step === "done" && "Redirecting to your dashboard..."}
            </p>
          </div>

          {/* Fields */}
          {step === "email" && (
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleContinue()}
            />
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
          {step === "totp" && (
            <input
              type="text"
              placeholder="000000"
              maxLength={6}
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))}
              className={`${inputCls} text-center text-lg tracking-[0.3em] font-mono`}
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
            {loading ? "Please wait..." : step === "done" ? "Redirecting..." : "Continue"}
          </button>
        </div>

        <p className="text-center text-[10px] text-muted-foreground mt-4">
          Nodus &middot; End-to-end encrypted peer-to-peer file sync
        </p>
      </div>
    </main>
  );
}