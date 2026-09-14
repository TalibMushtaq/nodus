"use client";

import { useState } from "react";
import { Toggle } from "@repo/ui/primitives/toggle";
import { Select } from "@repo/ui/primitives/select";
import { Section } from "@repo/ui/primitives/section";
import { PageHeader } from "@repo/ui/primitives/page-header";
import { SettingRow } from "@repo/ui/primitives/setting-row";
import { Button } from "@repo/ui/primitives/button";
import { ConfirmDialog } from "@repo/ui/primitives/overlay";
import { useTheme } from "../../../providers/theme-provider";
import { usePreferences, clearPreferences } from "../../../lib/preferences";
import { clearLocalDatabase } from "../../../lib/db";

// Settings is limited to controls with a real backing behavior: theme (persisted
// by ThemeProvider), local sync preferences (localStorage), and clearing the
// device's local data. The former mock account/GC/notification sections were
// removed rather than left as dead controls.

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { preferences, update } = usePreferences();
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);

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
    <div className="mx-auto max-w-3xl space-y-8 p-6">
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
