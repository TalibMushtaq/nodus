import type { ReactNode } from "react";

// The status "wordmark" — one consistent sync/connection language reused
// everywhere. Shapes+labels accompany every color so states read for
// colorblind users, matching the prototype's StatusBadge exactly.

export type SyncStatus = "synced" | "pending" | "conflict" | "offline" | "local-only";

interface StatusConfig {
  label: string;
  color: string;
  bg: string;
  icon: ReactNode;
}

function SyncedIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
      <circle cx="4" cy="4" r="3.5" fill="currentColor" />
    </svg>
  );
}

function PendingIcon({ animate }: { animate?: boolean }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className={animate ? "animate-pulse" : ""}>
      <circle cx="4" cy="4" r="3" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4" cy="4" r="1" fill="currentColor" />
    </svg>
  );
}

function ConflictIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
      <path d="M4 0.5L7.5 4L4 7.5L0.5 4L4 0.5Z" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M4 2.5V5M4 5.5V6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function OfflineIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
      <circle cx="4" cy="4" r="3" stroke="currentColor" strokeWidth="1" strokeDasharray="2 1.5" />
    </svg>
  );
}

function LocalOnlyIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
      <path d="M4 0.5L7.5 4L4 7.5L0.5 4L4 0.5Z" fill="currentColor" />
    </svg>
  );
}

const configs: Record<SyncStatus, StatusConfig> = {
  synced: {
    label: "Synced",
    color: "var(--status-synced)",
    bg: "var(--status-synced-bg)",
    icon: <SyncedIcon />,
  },
  pending: {
    label: "Pending",
    color: "var(--status-pending)",
    bg: "var(--status-pending-bg)",
    icon: <PendingIcon animate />,
  },
  conflict: {
    label: "Conflict",
    color: "var(--status-conflict)",
    bg: "var(--status-conflict-bg)",
    icon: <ConflictIcon />,
  },
  offline: {
    label: "Offline",
    color: "var(--status-offline)",
    bg: "var(--status-offline-bg)",
    icon: <OfflineIcon />,
  },
  "local-only": {
    label: "Local only",
    color: "var(--status-local)",
    bg: "var(--status-local-bg)",
    icon: <LocalOnlyIcon />,
  },
};

export interface StatusBadgeProps {
  status: SyncStatus;
  variant?: "badge" | "dot" | "inline";
}

export function StatusBadge({ status, variant = "badge" }: StatusBadgeProps) {
  const cfg = configs[status];

  if (variant === "dot") {
    return (
      <span style={{ color: cfg.color }} title={cfg.label}>
        {cfg.icon}
      </span>
    );
  }

  if (variant === "inline") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: cfg.color }}>
        {cfg.icon}
        {cfg.label}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-full"
      style={{ color: cfg.color, backgroundColor: cfg.bg, border: `1px solid ${cfg.color}30` }}
    >
      {cfg.icon}
      {cfg.label}
    </span>
  );
}