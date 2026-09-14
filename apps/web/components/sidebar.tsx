"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@repo/ui/primitives/icons";
import { StatusBadge } from "@repo/ui/primitives/badge";
import { Logo } from "@repo/ui/primitives/brand";
import type { IconName } from "@repo/ui/primitives/icons";

import { useAuth } from "../providers/auth-provider";
import { useWs } from "../providers/ws-provider";
import { isRelayOnline, relayStatusLabel } from "../lib/connectivity";
import { useNodeStatus } from "../lib/use-node-status";

// Persistent sidebar. Navigation is driven by the URL path via next/link +
// usePathname rather than client-side state, so the browser's back button
// works and deep-linking is preserved.

type NavPage = "overview" | "files" | "conflicts" | "devices" | "activity" | "security" | "settings" | "tombstones";

const navItems: { id: NavPage; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "overview" },
  { id: "files", label: "Backups", icon: "files" },
  { id: "conflicts", label: "Conflicts", icon: "copy" },
  { id: "tombstones", label: "Tombstone", icon: "trash" },
  { id: "devices", label: "Devices", icon: "devices" },
  { id: "activity", label: "Activity", icon: "activity" },
  { id: "security", label: "Security", icon: "security" },
  { id: "settings", label: "Settings", icon: "settings" },
];

interface SidebarProps {
  collapsed: boolean;
  onCollapse: () => void;
}

export function Sidebar({ collapsed, onCollapse }: SidebarProps) {
  const pathname = usePathname();
  const { session } = useAuth();
  const { status: wsStatus } = useWs();

  // Live relay connectivity instead of a hard-coded "Online · Local P2P".
  const relayOnline = isRelayOnline(wsStatus);
  // Transitional states read as "pending", not green: the socket exists but
  // traffic cannot flow until it reaches `connected`.
  const relayBadge =
    relayOnline ? "synced" : wsStatus === "connecting" || wsStatus === "reconnecting" ? "pending" : "offline";

  // Aggregated node online/offline count from the Relay catalog.
  const { total: nodeTotal, online: nodeOnline } = useNodeStatus();
  const anyNodeOnline = nodeOnline > 0;
  const nodeBadge: "synced" | "offline" = nodeTotal === 0 || anyNodeOnline ? "synced" : "offline";
  const nodeLabel =
    nodeTotal === 0
      ? "Not paired"
      : anyNodeOnline
        ? `Online (${nodeOnline}/${nodeTotal})`
        : "Offline";
  // "Not paired" is informational, not a problem state — tone it down.
  const nodeBadgeOverride = nodeTotal === 0 ? "offline" : nodeBadge;

  const accountId = session?.account_id ?? "";

  return (
    <aside
      className={`flex flex-col h-full transition-all duration-200 border-r border-border surface-warm ${
        collapsed ? "w-14" : "w-56"
      }`}
    >
      {/* Logo */}
      <div className={`flex items-center gap-2.5 px-4 h-13 border-b border-border ${collapsed ? "justify-center px-0" : ""}`}>
        <span className="text-accent shrink-0">
          <Logo size={20} />
        </span>
        {!collapsed && (
          <span className="font-display text-[15px] font-semibold tracking-[-0.01em] text-foreground">
            Nodus
          </span>
        )}
      </div>

      {/* Relay status */}
      {!collapsed && (
        <div className="px-3 pt-3 pb-1">
          {/* Presence readout: the two live signals that gate everything else,
              folded into one bordered card so it reads as a single instrument
              cluster rather than two floating pills. */}
          <div className="overflow-hidden rounded-xl border border-border bg-card/70 divide-y divide-border">
            <div className="flex items-center gap-2 px-2.5 py-2">
              <StatusBadge status={relayBadge} variant="dot" />
              <span className="text-xs text-muted-foreground font-mono truncate">
                Relay · {relayStatusLabel(wsStatus)}
              </span>
            </div>
            <div className="flex items-center gap-2 px-2.5 py-2">
              <StatusBadge status={nodeBadgeOverride} variant="dot" />
              <span className="text-xs text-muted-foreground font-mono truncate">
                Node · {nodeLabel}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Nav */}
      <nav aria-label="Primary" className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const active = pathname === `/${item.id}`;
          return (
            <Link
              key={item.id}
              href={`/${item.id}`}
              className={`w-full flex items-center gap-3 px-2.5 py-2.5 text-sm rounded-xl transition-all ${
                active
                  ? "text-white font-semibold accent-gradient elev-card"
                  : "text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
              } ${collapsed ? "justify-center" : ""}`}
              title={collapsed ? item.label : undefined}
            >
              <Icon name={item.icon} />
              {!collapsed && item.label}
            </Link>
          );
        })}
      </nav>

      {/* Account */}
      {!collapsed && accountId && (
        <div className="px-3 py-3 border-t border-border">
          <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-sm">
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-foreground truncate">Account</div>
              <div className="text-[10px] text-muted-foreground font-mono truncate">{accountId.slice(0, 12)}…</div>
            </div>
          </div>
        </div>
      )}

      {/* Collapse toggle */}
      <button
        type="button"
        onClick={onCollapse}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="flex items-center justify-center h-9 border-t border-border text-muted-foreground hover:text-foreground transition-colors"
      >
        <Icon name="chevron-left" size={14} className={`transition-transform ${collapsed ? "rotate-180" : ""}`} />
      </button>
    </aside>
  );
}