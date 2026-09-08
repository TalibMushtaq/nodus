import type { ReactNode } from "react";

// Path indicator: how data is moving (local P2P, relay, buffered, offline).
// Mono face + color + glyph distinguishes it from the status wordmark.

export type TransferPath = "local" | "relay" | "buffered" | "offline";

function LocalIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M1 5H9M1 5L3.5 2.5M1 5L3.5 7.5M9 5L6.5 2.5M9 5L6.5 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RelayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M5 1C5 1 8 3 8 5C8 7 5 9 5 9C5 9 2 7 2 5C2 3 5 1 5 1Z" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <circle cx="5" cy="5" r="1.5" fill="currentColor" />
    </svg>
  );
}

function BufferedIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 3.5H8M2 5H6.5M2 6.5H5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function OfflineIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 2L8 8M2 8L8 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

const configs: Record<TransferPath, { label: string; color: string; icon: ReactNode }> = {
  local: { label: "Local P2P", color: "var(--status-synced)", icon: <LocalIcon /> },
  relay: { label: "Relay", color: "var(--status-pending)", icon: <RelayIcon /> },
  buffered: { label: "Relay buffer", color: "var(--status-pending)", icon: <BufferedIcon /> },
  offline: { label: "Offline", color: "var(--status-offline)", icon: <OfflineIcon /> },
};

export function PathIndicator({ path }: { path: TransferPath }) {
  const cfg = configs[path];
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-mono font-semibold px-2 py-0.5 rounded-full"
      style={{ color: cfg.color, background: cfg.color + "18", border: `1px solid ${cfg.color}40` }}
    >
      {cfg.icon}
      {cfg.label}
    </span>
  );
}