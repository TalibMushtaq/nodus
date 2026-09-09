"use client";

import { useState } from "react";
import { Toggle } from "@repo/ui/primitives/toggle";
import { Select } from "@repo/ui/primitives/select";
import { Section } from "@repo/ui/primitives/section";
import { SettingRow } from "@repo/ui/primitives/setting-row";
import { Button } from "@repo/ui/primitives/button";
import { useTheme } from "../../../providers/theme-provider";

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [autoSync, setAutoSync] = useState(true);
  const [nodeLimit, setNodeLimit] = useState("5");

  return (
    <div className="space-y-6 p-6">
      <Section title="Appearance">
        <div className="border border-border rounded-xl bg-card px-4">
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
        <div className="border border-border rounded-xl bg-card px-4">
          <SettingRow label="Auto-sync" detail="Automatically sync changes when detected">
            <Toggle aria-label="Auto-sync" checked={autoSync} onChange={setAutoSync} />
          </SettingRow>
          <SettingRow label="Max nodes" detail="Maximum number of storage nodes to connect to simultaneously">
            <Select aria-label="Max nodes" value={nodeLimit} onChange={(e) => setNodeLimit(e.target.value)}>
              <option value="3">3</option>
              <option value="5">5</option>
              <option value="10">10</option>
              <option value="20">20</option>
            </Select>
          </SettingRow>
        </div>
      </Section>

      <Section title="Danger zone">
        <div className="border border-destructive/30 rounded-xl bg-card px-4">
          <SettingRow label="Reset all data" detail="This cannot be undone. All local files will be removed.">
            <Button variant="destructive" size="sm">Reset</Button>
          </SettingRow>
        </div>
      </Section>
    </div>
  );
}