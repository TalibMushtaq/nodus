"use client";

import { NetworkTopology } from "@repo/ui/domain/network-topology";
import { StatCard } from "@repo/ui/primitives/stat-card";
import { Section } from "@repo/ui/primitives/section";

export default function OverviewPage() {
  return (
    <div className="space-y-6 p-6">
      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard label="Files" value="1,847" sub="Local" link="View files \u2192" color="var(--color-accent)" />
        <StatCard label="Used" value="2.3 TB" sub="Home NAS" link="Manage storage \u2192" color="#059669" />
        <StatCard label="Pending" value="3" sub="Syncing" link="View activity \u2192" color="var(--status-pending)" />
        <StatCard label="Conflicts" value="1" sub="Needs attention" link="Resolve now \u2192" color="var(--status-conflict)" />
      </div>

      {/* Network topology */}
      <Section title="Network">
        <NetworkTopology />
      </Section>

      {/* Quick access */}
      <Section title="Quick access">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { name: "Documents", count: "247 files", color: "var(--color-accent)" },
            { name: "Photos", count: "1,204 files", color: "#059669" },
            { name: "Projects", count: "89 files", color: "var(--status-pending)" },
            { name: "Backups", count: "12 files", color: "var(--color-destructive)" },
          ].map((f) => (
            <div key={f.name} className="flex items-center gap-3 px-4 py-3 border border-border hover:bg-secondary/40 transition-colors cursor-pointer">
              <div className="w-9 h-9 bg-secondary border border-border flex items-center justify-center shrink-0">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <path d="M1.5 4.5h4l1.5-2h7.5v9h-13V4.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" className="text-muted-foreground" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-foreground font-medium">{f.name}</div>
                <div className="text-[10px] text-muted-foreground font-mono">{f.count}</div>
              </div>
              <div className="w-1 h-9 rounded-full shrink-0" style={{ backgroundColor: f.color }} />
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}