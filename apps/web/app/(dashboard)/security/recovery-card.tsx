"use client";

import { useCallback, useEffect, useState } from "react";
import { Section } from "@repo/ui/primitives/section";
import { Button } from "@repo/ui/primitives/button";
import { Input } from "@repo/ui/primitives/input";
import { Modal, ModalHeader } from "@repo/ui/primitives/overlay";
import { shortId } from "../../../lib/format";
import { useAuth } from "../../../providers/auth-provider";
import { useRecoveryReseal } from "../../../lib/use-recovery-reseal";
import {
  createRecoveryPhrase,
  enrollRecoveryKey,
  loadRecoveryPhrase,
  recoveryPublicKey,
  saveRecoveryPhrase,
} from "../../../lib/recovery";

// Account recovery card (ADR-0002). The phrase is generated on-device and kept
// locally, so this card can reveal and copy it later; only the derived public
// key is enrolled on the Relay. Enrolling or regenerating re-seals every key
// this device can open to the new recovery identity.
//
// Enrollment asks for the account password because the Relay drops the previous
// recovery key's envelope coverage on every rotation. Requiring the password
// means a stolen session alone cannot be used to destroy the owner's ability to
// recover their account.

interface PendingPhrase {
  mode: "setup" | "regenerate";
  phrase: string;
}

function maskPhrase(phrase: string): string {
  const words = phrase.split(" ");
  // Reveal the first and last word as an orientation cue, mask the rest.
  return words.map((word, index) => (index === 0 || index === words.length - 1 ? word : "••••")).join(" ");
}

export function RecoveryCard() {
  const { session, refresh } = useAuth();
  const { reseal, busy: resealing } = useRecoveryReseal();
  const [phrase, setPhrase] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState<PendingPhrase | null>(null);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  // Held only for the duration of the enroll modal and cleared on close; the
  // Relay needs it to authorize the destructive envelope cleanup.
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const enrolled = Boolean(session?.recovery_public_key);
  const accountId = session?.account_id ?? "";

  // Hydrate the locally-kept phrase once the account is known. A phrase that no
  // longer matches the enrolled key (rotated on another device) is treated as
  // absent so the card does not present a stale phrase as the active key.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    loadRecoveryPhrase(accountId).then((stored) => {
      if (cancelled) return;
      const enrolledKey = session?.recovery_public_key ?? null;
      if (stored && (!enrolledKey || recoveryPublicKey(stored) === enrolledKey)) {
        setPhrase(stored);
      } else {
        setPhrase(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, session?.recovery_public_key]);

  const openPending = useCallback((mode: "setup" | "regenerate") => {
    setError(null);
    setNotice(null);
    setSavedConfirmed(false);
    setPassword("");
    setPending({ mode, phrase: createRecoveryPhrase() });
  }, []);

  const closePending = useCallback(() => {
    setPending(null);
    setPassword("");
  }, []);

  const confirmEnroll = useCallback(async () => {
    if (!pending || !accountId) return;
    if (!savedConfirmed) {
      setError("Confirm you have saved your recovery phrase");
      return;
    }
    if (!password) {
      setError("Enter your account password to confirm");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const publicKey = recoveryPublicKey(pending.phrase);
      // Re-seal to the new identity BEFORE enrolling: the Relay drops only the
      // previous key's envelopes on enroll, so the fresh coverage survives. If
      // the re-seal fails, the account is untouched and the user can retry.
      const result = await reseal(publicKey);
      await enrollRecoveryKey(publicKey, password);
      await saveRecoveryPhrase(accountId, pending.phrase);
      setPhrase(pending.phrase);
      setPassword("");
      setPending(null);
      setRevealed(true);
      setNotice(
        `Recovery key enrolled. Re-sealed ${result.files} file key${result.files === 1 ? "" : "s"} and ` +
          `${result.folders} folder key${result.folders === 1 ? "" : "s"}` +
          (result.skipped > 0 ? `; ${result.skipped} key${result.skipped === 1 ? "" : "s"} not readable on this device.` : "."),
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [pending, accountId, savedConfirmed, password, reseal, refresh]);

  const copy = useCallback(async () => {
    if (!phrase) return;
    try {
      await navigator.clipboard.writeText(phrase);
      setNotice("Recovery phrase copied.");
    } catch {
      setError("Clipboard is unavailable; select the words manually.");
    }
  }, [phrase]);

  return (
    <Section title="Recovery key">
      <div className="elev-card bg-card border border-border rounded-2xl p-5 space-y-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Your recovery key is the only way to access your files if you lose all trusted devices.
          Store it somewhere safe and offline. Nodus never sends this key to any server.
        </p>

        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
        {notice && <p className="text-xs text-muted-foreground" role="status">{notice}</p>}

        {enrolled && phrase ? (
          <>
            <div className="bg-secondary border border-border px-4 py-3 font-mono text-sm tracking-wide text-center select-all break-words">
              {revealed ? phrase : maskPhrase(phrase)}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setRevealed((value) => !value)}>
                {revealed ? "Hide key" : "Reveal key"}
              </Button>
              {revealed && (
                <Button variant="secondary" size="sm" onClick={() => void copy()}>
                  Copy
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto text-destructive hover:bg-destructive/10"
                onClick={() => openPending("regenerate")}
              >
                Regenerate key…
              </Button>
            </div>
            {revealed && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Your recovery key is visible. Make sure no one else can see your screen before
                copying it.
              </p>
            )}
          </>
        ) : enrolled ? (
          <>
            <div className="bg-secondary border border-border px-4 py-3 font-mono text-xs text-muted-foreground break-all">
              {session?.recovery_public_key ? shortId(session.recovery_public_key, 24) : ""}
            </div>
            <p className="text-xs text-muted-foreground">
              Recovery is enrolled, but the phrase is stored only on the device that created it.
              Regenerate to get a new phrase on this device.
            </p>
            <Button variant="secondary" size="sm" onClick={() => openPending("regenerate")}>
              Regenerate key…
            </Button>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Recovery is not set up yet. Without it, losing every trusted device means losing access
              to your files.
            </p>
            <Button variant="primary" size="sm" onClick={() => openPending("setup")}>
              Set up recovery key
            </Button>
          </>
        )}
      </div>

      {pending && (
        <Modal className="w-[440px] max-w-full" onClose={busy ? () => undefined : closePending}>
          <ModalHeader
            title={pending.mode === "setup" ? "Set up recovery key" : "Regenerate recovery key"}
            onClose={busy ? () => undefined : closePending}
          />
          <div className="p-5 space-y-4">
            <p className="text-xs text-muted-foreground">
              Write these 24 words down in order and keep them offline. Anyone with this phrase can
              access your account, and Nodus cannot restore it for you.
            </p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 p-3 bg-secondary border border-border rounded-lg">
              {pending.phrase.split(" ").map((word, index) => (
                <div key={`${word}-${index}`} className="flex items-baseline gap-1.5 text-xs font-mono text-foreground">
                  <span className="text-muted-foreground w-4 text-right shrink-0">{index + 1}</span>
                  <span className="truncate">{word}</span>
                </div>
              ))}
            </div>
            <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={savedConfirmed}
                onChange={(e) => setSavedConfirmed(e.target.checked)}
                className="mt-0.5"
              />
              I have saved my recovery phrase somewhere safe.
            </label>
            <Input
              label="Account password"
              hint="Required to confirm. Replacing the recovery key removes the previous key's access to your files."
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closePending} disabled={busy || resealing}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void confirmEnroll()}
                disabled={busy || resealing || !savedConfirmed || !password}
              >
                {busy || resealing ? "Enrolling…" : "Enroll recovery key"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Section>
  );
}
