"use client";

import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/primitives/icons";

import { useAuth } from "../../providers/auth-provider";
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
//
// Layout mirrors the nodus-design AuthFlow: a fixed dark brand panel (topology
// diagram + value prop) on the left, and a plain, label-led form column on the
// right. The panel is decorative, so it is hidden below `lg` and marked
// aria-hidden. All field logic below is unchanged from the original wizard.

type AuthStep = "email" | "password" | "recovery" | "phrase";
type AuthMode = "signin" | "register" | "recover";

const inputCls =
  "w-full px-3.5 py-2.5 text-sm bg-background border border-border rounded-xl text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20";

/** Labelled field: a visible caption owns the input (implicit label wrapping). */
function AuthField({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <input {...props} className={inputCls} />
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** Accent-gradient submit, matching the primary action across the app. */
function PrimaryButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="accent-gradient elev-card w-full rounded-xl py-3 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-95 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** Step-back control: the chevron + label pattern from the design. */
function BackButton({ onClick, label = "Back" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-4 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <Icon name="chevron-left" size={12} />
      {label}
    </button>
  );
}

// ── Brand panel ────────────────────────────────────────────────────────

/** One node box in the topology diagram. */
function DiagramBox({
  x,
  y,
  width,
  height,
  fill,
  stroke,
  children,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  children: ReactNode;
}) {
  return (
    <>
      <rect x={x} y={y} width={width} height={height} rx={6} fill={fill} stroke={stroke} strokeWidth={1.5} />
      {children}
    </>
  );
}

const PANEL_FEATURES = [
  { label: "Offline-first", desc: "Works without internet" },
  { label: "End-to-end encrypted", desc: "Relay never sees plaintext" },
  { label: "P2P sync", desc: "Direct to your storage node" },
];

function BrandPanel() {
  return (
    <div
      aria-hidden
      className="relative hidden flex-col justify-between overflow-hidden p-10 lg:flex"
      style={{ background: "var(--brand-surface)" }}
    >
      {/* Concentric rings — the design's cover motif. */}
      <div
        className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full border opacity-10"
        style={{ borderColor: "var(--brand-accent)" }}
      />
      <div
        className="pointer-events-none absolute -right-12 -top-12 h-64 w-64 rounded-full border opacity-10"
        style={{ borderColor: "var(--brand-accent)" }}
      />
      <div
        className="pointer-events-none absolute -bottom-16 -left-16 h-72 w-72 rounded-full border opacity-10"
        style={{ borderColor: "var(--brand-accent)" }}
      />

      <div className="relative z-10 flex items-center gap-2.5">
        <span style={{ color: "var(--brand-accent)" }}>
          <Icon name="logo" size={22} />
        </span>
        <span
          className="font-display text-sm font-semibold tracking-[-0.01em]"
          style={{ color: "var(--brand-ink)" }}
        >
          Nodus
        </span>
      </div>

      <div className="relative z-10 flex flex-1 items-center justify-center py-10">
        <svg width="260" height="220" viewBox="0 0 260 220" fill="none">
          <DiagramBox x={100} y={10} width={60} height={40} fill="var(--brand-panel)" stroke="var(--brand-accent)">
            <text x={130} y={28} textAnchor="middle" fill="var(--brand-accent)" fontSize="8" fontFamily="monospace">
              GO
            </text>
            <text x={130} y={40} textAnchor="middle" fill="var(--brand-ink-muted)" fontSize="7">
              Relay
            </text>
          </DiagramBox>

          <DiagramBox x={90} y={90} width={80} height={50} fill="var(--brand-panel)" stroke="var(--brand-accent)">
            <text x={130} y={110} textAnchor="middle" fill="var(--brand-ink)" fontSize="8" fontFamily="monospace">
              RUST
            </text>
            <text x={130} y={123} textAnchor="middle" fill="var(--brand-accent)" fontSize="7">
              Storage Node
            </text>
            <circle cx={130} cy={134} r={2} fill="var(--brand-synced)" />
          </DiagramBox>

          <DiagramBox
            x={20}
            y={170}
            width={60}
            height={38}
            fill="var(--brand-panel-alt)"
            stroke="var(--brand-panel-line)"
          >
            <text x={50} y={187} textAnchor="middle" fill="var(--brand-ink-muted)" fontSize="7">
              Web
            </text>
            <text x={50} y={199} textAnchor="middle" fill="var(--brand-ink-faint)" fontSize="7" fontFamily="monospace">
              client
            </text>
          </DiagramBox>

          <DiagramBox
            x={180}
            y={170}
            width={60}
            height={38}
            fill="var(--brand-panel-alt)"
            stroke="var(--brand-panel-line)"
          >
            <text x={210} y={187} textAnchor="middle" fill="var(--brand-ink-muted)" fontSize="7">
              Mobile
            </text>
            <text x={210} y={199} textAnchor="middle" fill="var(--brand-ink-faint)" fontSize="7" fontFamily="monospace">
              client
            </text>
          </DiagramBox>

          <line x1={130} y1={50} x2={130} y2={90} stroke="var(--brand-accent)" strokeWidth={1} strokeDasharray="3 3" opacity="0.5" />
          <line x1={100} y1={130} x2={65} y2={170} stroke="var(--brand-synced)" strokeWidth={1.5} opacity="0.7" />
          <line x1={160} y1={130} x2={195} y2={170} stroke="var(--brand-synced)" strokeWidth={1.5} opacity="0.7" />
          <line x1={110} y1={50} x2={62} y2={170} stroke="var(--brand-panel-line)" strokeWidth={1} strokeDasharray="2 4" opacity="0.4" />
          <line x1={150} y1={50} x2={198} y2={170} stroke="var(--brand-panel-line)" strokeWidth={1} strokeDasharray="2 4" opacity="0.4" />

          <line x1={20} y1={82} x2={36} y2={82} stroke="var(--brand-synced)" strokeWidth={1.5} />
          <text x={40} y={86} fill="var(--brand-synced)" fontSize="7" opacity="0.75">
            Local P2P
          </text>
          <line x1={20} y1={94} x2={36} y2={94} stroke="var(--brand-accent)" strokeWidth={1} strokeDasharray="3 3" />
          <text x={40} y={98} fill="var(--brand-accent)" fontSize="7" opacity="0.7">
            Relay fallback
          </text>
        </svg>
      </div>

      <div className="relative z-10 space-y-6">
        <p className="font-display text-xl font-semibold leading-snug" style={{ color: "var(--brand-ink)" }}>
          Your files.
          <br />
          Your hardware.
          <br />
          <span style={{ color: "var(--brand-accent)" }}>No compromises.</span>
        </p>
        <div className="space-y-2">
          {PANEL_FEATURES.map((feature) => (
            <div key={feature.label} className="flex items-center gap-3">
              <div className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: "var(--brand-accent)" }} />
              <span className="text-xs" style={{ color: "var(--brand-ink-muted)" }}>
                <span className="font-medium" style={{ color: "var(--brand-ink)" }}>
                  {feature.label}
                </span>{" "}
                — {feature.desc}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────

export default function AuthPage() {
  const router = useRouter();
  const { login, register, refresh, status, serverReachable, device } = useAuth();

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
        if (!device) {
          setError("Device identity is still loading; try again in a moment.");
          return;
        }
        const res = await recoverAccount(email, normalized, device);
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

  const title =
    mode === "register" && step === "recovery"
      ? "Save your recovery phrase"
      : mode === "register"
        ? step === "password"
          ? "Choose a password"
          : "Create your account"
        : mode === "recover"
          ? step === "phrase"
            ? "Enter your recovery phrase"
            : "Recover your account"
          : step === "password"
            ? "Enter your password"
            : "Welcome back";

  const subtitle =
    step === "email"
      ? mode === "register"
        ? "Sign up to sync your files across devices"
        : mode === "recover"
          ? "Use your offline recovery phrase to sign in on this device"
          : "Sign in to sync your files across devices"
      : step === "recovery"
        ? "The only way to recover your files if you lose every device"
        : `For ${email}`;

  return (
    <main className="grid min-h-dvh bg-background lg:grid-cols-2">
      <BrandPanel />

      <div className="flex min-h-dvh flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-12">
          {/* Mobile brand (the left panel is hidden below lg) */}
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="text-accent">
              <Icon name="logo" size={22} />
            </span>
            <span className="font-display text-lg font-semibold tracking-[-0.02em] text-foreground">Nodus</span>
          </div>

          {!serverReachable && (
            <div
              className="mb-6 rounded-r-xl border-l-[3px] bg-secondary px-3.5 py-3 text-xs leading-relaxed text-muted-foreground"
              style={{ borderLeftColor: "var(--color-destructive)" }}
              role="status"
            >
              Server unreachable — sign-in won&apos;t work until the relay is back online.
            </div>
          )}

          {/* Header */}
          <div className="mb-6">
            {/* Back navigation mirrors the wizard's previous inline links. */}
            {step === "password" && <BackButton label="Use a different email" onClick={() => { setStep("email"); setPassword(""); setError(null); }} />}
            {step === "phrase" && <BackButton label="Use a different email" onClick={() => { setStep("email"); setRecoveryInput(""); setError(null); }} />}
            {step === "email" && mode === "recover" && <BackButton label="Back to sign in" onClick={() => switchMode("signin")} />}
            <h1 className="font-display text-xl font-semibold tracking-[-0.01em] text-foreground">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          </div>

          {/* Fields */}
          <div className="space-y-4">
            {step === "email" && (
              <>
                <AuthField
                  label="Email"
                  type="email"
                  placeholder="you@example.com"
                  aria-label="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => e.key === "Enter" && handleContinue()}
                />
                {/* Recover mode's back link lives in the header; the two mode
                    toggles only make sense for password auth. */}
                {mode !== "recover" && (
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => setMode(mode === "signin" ? "register" : "signin")}
                      className="block text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {mode === "signin" ? "Don't have an account? Create one" : "Already have an account? Sign in"}
                    </button>
                    <button
                      type="button"
                      onClick={() => switchMode("recover")}
                      className="block text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      Lost your devices? Use a recovery key
                    </button>
                  </div>
                )}
              </>
            )}

            {step === "password" && (
              <AuthField
                label="Password"
                type="password"
                placeholder="Your password"
                aria-label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                hint={mode === "register" ? "8 characters minimum. Used to encrypt your device credentials." : undefined}
                onKeyDown={(e) => e.key === "Enter" && handleContinue()}
              />
            )}

            {step === "phrase" && (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-foreground">Recovery phrase</span>
                <textarea
                  placeholder="Enter your 24-word recovery phrase"
                  aria-label="Recovery phrase"
                  value={recoveryInput}
                  onChange={(e) => setRecoveryInput(e.target.value)}
                  rows={3}
                  className={`${inputCls} resize-none font-mono`}
                  autoFocus
                />
              </label>
            )}

            {step === "recovery" && (
              <>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-xl border border-border bg-secondary p-3">
                  {recoveryPhrase.split(" ").map((word, index) => (
                    <div key={`${word}-${index}`} className="flex items-baseline gap-1.5 font-mono text-xs text-foreground">
                      <span className="w-4 shrink-0 text-right text-muted-foreground">{index + 1}</span>
                      <span className="truncate">{word}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                  Write these 24 words down in order and keep them offline. Anyone with this phrase can access
                  your account, and Nodus cannot restore it for you.
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
          </div>

          {/* Error */}
          {error && (
            <p className="mt-4 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}

          {/* Continue */}
          <div className="mt-6">
            <PrimaryButton
              onClick={handleContinue}
              disabled={loading || !serverReachable}
              title={!serverReachable ? "The relay is unreachable" : undefined}
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
            </PrimaryButton>
          </div>
        </div>

        <p className="pb-6 text-center text-[11px] text-muted-foreground">
          Nodus · End-to-end encrypted peer-to-peer file sync
        </p>
      </div>
    </main>
  );
}
