"use client";

import { useState } from "react";
import { Toggle } from "@repo/ui/primitives/toggle";
import { Select } from "@repo/ui/primitives/select";
import { Section } from "@repo/ui/primitives/section";
import { PageHeader } from "@repo/ui/primitives/page-header";
import { SettingRow } from "@repo/ui/primitives/setting-row";
import { Button } from "@repo/ui/primitives/button";
import { Input } from "@repo/ui/primitives/input";
import { ConfirmDialog } from "@repo/ui/primitives/overlay";
import { BrowserNotifications } from "../../../components/browser-notifications";
import { useTheme } from "../../../providers/theme-provider";
import { usePreferences, clearPreferences } from "../../../lib/preferences";
import { clearLocalDatabase } from "../../../lib/db";
import { changePassword, logoutAll } from "../../../lib/auth-client";

// Settings holds only controls with a real backing behavior: theme (persisted
// by ThemeProvider), local sync preferences (localStorage), credential changes,
// the browser push opt-in (Web Push), and clearing the device's local data. The
// former mock account/GC sections were removed rather than left as dead controls.

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { preferences, update } = usePreferences();
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);

  // Credential changes rotate the session server-side; the client just needs
  // the current credential to authorize and to surface the rotation result.
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [securityBusy, setSecurityBusy] = useState<"password" | "logout-all" | null>(null);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);

  const submitPassword = async () => {
    setSecurityError(null);
    setSecurityNotice(null);
    if (newPassword !== confirmPassword) {
      setSecurityError("New password and confirmation do not match.");
      return;
    }
    if (newPassword.length < 8) {
      setSecurityError("New password must be at least 8 characters.");
      return;
    }
    setSecurityBusy("password");
    try {
      const result = await changePassword(currentPassword, newPassword);
      if (!result.ok) {
        setSecurityError(result.error ?? "Could not change password.");
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSecurityNotice("Password changed. This browser now holds a new session.");
    } finally {
      setSecurityBusy(null);
    }
  };

  const signOutEverywhere = async () => {
    setSecurityError(null);
    setSecurityNotice(null);
    setSecurityBusy("logout-all");
    try {
      const result = await logoutAll();
      if (!result.ok) {
        setSecurityError(result.error ?? "Could not sign out other devices.");
        return;
      }
      setSecurityNotice("All other devices were signed out.");
    } finally {
      setSecurityBusy(null);
    }
  };

  // Delete the entire local DB (catalog, keys, trusted nodes, queues) plus the
  // preference record. Keeps the session/device identity so the account is not
  // silently signed out.
  const reset = async () => {
    setResetting(true);
    setResetError(null);
    try {
      await clearLocalDatabase();
      clearPreferences();
      setResetDone(true);
      setResetOpen(false);
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="w-full space-y-8 p-6">
      <PageHeader
        eyebrow="Preferences"
        title="Settings"
        description="Appearance, local sync defaults, and the device-level reset."
      />

      <Section title="Appearance">
        <div className="elev-card border border-border rounded-2xl bg-card px-4">
          <SettingRow label="Theme" detail="Light, dark, or system preference">
            <Select
              aria-label="Theme"
              value={theme}
              onChange={(e) => setTheme(e.target.value as "light" | "dark" | "system")}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">System</option>
            </Select>
          </SettingRow>
        </div>
      </Section>

      <Section title="Notifications">
        <div className="elev-card border border-border rounded-2xl bg-card px-4 py-3">
          <BrowserNotifications />
        </div>
      </Section>

      <Section title="Sync">
        <div className="elev-card border border-border rounded-2xl bg-card px-4">
          <SettingRow label="Auto-sync" detail="Saved on this device">
            <Toggle
              aria-label="Auto-sync"
              checked={preferences.autoSync}
              onChange={(autoSync) => update({ autoSync })}
            />
          </SettingRow>
          <SettingRow label="Max nodes" detail="Saved on this device">
            <Select
              aria-label="Max nodes"
              value={String(preferences.maxNodes)}
              onChange={(e) => update({ maxNodes: Number(e.target.value) })}
            >
              <option value="3">3</option>
              <option value="5">5</option>
              <option value="10">10</option>
              <option value="20">20</option>
            </Select>
          </SettingRow>
          <SettingRow
            label="Shard size"
            detail="Bigger shards mean fewer transfers; the storage node and relay must allow the size."
          >
            <Select
              aria-label="Shard size"
              value={String(preferences.shardSizeBytes)}
              onChange={(e) => update({ shardSizeBytes: Number(e.target.value) })}
            >
              <option value={8 * 1024 * 1024}>8 MB</option>
              <option value={16 * 1024 * 1024}>16 MB</option>
              <option value={32 * 1024 * 1024}>32 MB</option>
            </Select>
          </SettingRow>
        </div>
      </Section>

      <Section title="Security">
        <div className="elev-card border border-border rounded-2xl bg-card px-4 py-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
            <Input
              label="New password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <Input
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              onClick={() => void submitPassword()}
              disabled={securityBusy !== null || !currentPassword || !newPassword}
            >
              {securityBusy === "password" ? "Changing…" : "Change password"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void signOutEverywhere()}
              disabled={securityBusy !== null}
            >
              {securityBusy === "logout-all" ? "Signing out…" : "Sign out all other devices"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Changing your password issues a new session for this browser and invalidates the old
            one. Signing out other devices keeps you signed in here.
          </p>
          {securityNotice && (
            <p className="text-xs text-muted-foreground" role="status">
              {securityNotice}
            </p>
          )}
          {securityError && (
            <p className="text-xs text-destructive" role="alert">
              {securityError}
            </p>
          )}
        </div>
      </Section>

      <Section title="Danger zone">
        <div className="elev-card border border-destructive/30 rounded-2xl bg-card px-4">
          <SettingRow
            label="Reset all data"
            detail="Removes local files, keys, and pairing data from this browser. This cannot be undone."
          >
            <Button variant="destructive" size="sm" onClick={() => setResetOpen(true)}>
              Reset
            </Button>
          </SettingRow>
        </div>
        {resetDone && (
          <p className="text-xs text-muted-foreground px-1 mt-2" role="status">
            Local data cleared. Your account is still signed in.
          </p>
        )}
        {resetError && <p className="text-xs text-destructive px-1 mt-2">{resetError}</p>}
      </Section>

      {resetOpen && (
        <ConfirmDialog
          title="Reset all local data"
          destructive
          busy={resetting}
          confirmLabel="Reset data"
          description={
            <>
              This deletes this browser&apos;s cached catalog, encryption keys, trusted nodes, and
              pending transfers. Your account and device identity are kept. This cannot be undone.
            </>
          }
          onConfirm={() => void reset()}
          onClose={() => setResetOpen(false)}
        />
      )}
    </div>
  );
}
