"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/primitives/icons";
import { Avatar } from "@repo/ui/primitives/brand";
import { useTheme } from "../providers/theme-provider";
import { useAuth } from "../providers/auth-provider";
import { useDownload } from "../providers/download-provider";

// The persistent top bar: page title, theme toggle, and the account menu.
//
// The former search field and notification bell were removed: neither had a
// handler or a backing data source, so they were pure false affordances. The
// account menu holds the app-level sign-out, which previously existed only on
// the standalone /pair screen.

interface TopBarProps {
  title: string;
  /** Opens the mobile navigation drawer; omitted on layouts without a sidebar. */
  onMenuClick?: () => void;
}

export function TopBar({ title, onMenuClick }: TopBarProps) {
  const { theme, setTheme, resolvedDark } = useTheme();
  const { session, logout } = useAuth();
  const { tasks } = useDownload();
  const router = useRouter();
  // Drives the badge on the downloads shortcut; only in-flight work counts, so a
  // finished list doesn't leave a permanent notification dot.
  const activeDownloads = tasks.filter((task) => task.status === "active").length;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Dismiss the account menu on outside click / Escape; otherwise it only
  // closes by re-clicking the avatar, which reads as a stuck popover.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const cycleTheme = () => {
    const order = ["light", "dark", "system"] as const;
    const idx = order.indexOf(theme);
    const next = order[(idx + 1) % order.length] ?? "system";
    setTheme(next);
  };

  // The Relay stores no display name/email — only the account id is known.
  const initials = (session?.account_id ?? "").slice(0, 2).toUpperCase() || "–";

  const signOut = async () => {
    setMenuOpen(false);
    await logout();
    router.push("/auth");
  };

  return (
    <header className="h-13 flex items-center gap-4 px-5 border-b border-border shrink-0 topbar-warm">
      {onMenuClick && (
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Open navigation"
          className="md:hidden text-muted-foreground hover:text-foreground transition-colors"
        >
          <Icon name="list-view" size={16} />
        </button>
      )}
      {/* Breadcrumb-style title: the product name anchors the left edge, the
          current section takes the display face so the header reads as an
          editorial masthead rather than a bare toolbar label. */}
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="hidden text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:inline">
          Nodus
        </span>
        <span className="hidden text-muted-foreground sm:inline">/</span>
        <h1 className="truncate font-display text-[15px] font-semibold tracking-[-0.01em] text-foreground">
          {title}
        </h1>
      </div>

      {/* Theme toggle */}
      <button
        type="button"
        onClick={cycleTheme}
        aria-label="Toggle theme"
        className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        title={`Current: ${theme}${theme === "system" ? ` (${resolvedDark ? "dark" : "light"})` : ""}`}
      >
        <Icon name={resolvedDark ? "sun" : "moon"} size={16} />
      </button>

      {/* Downloads shortcut — the dedicated tab the widget funnels into. Lives
          here (next to the account avatar) rather than only in the sidebar so an
          in-flight transfer is reachable from any page via one click. */}
      <button
        type="button"
        onClick={() => router.push("/downloads")}
        aria-label={
          activeDownloads > 0 ? `Downloads, ${activeDownloads} active` : "Downloads"
        }
        title="Downloads"
        className="relative flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <Icon name="download" size={16} className={activeDownloads > 0 ? "animate-pulse" : ""} />
        {activeDownloads > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full accent-gradient px-1 text-[9px] font-semibold text-white">
            {activeDownloads > 9 ? "9+" : activeDownloads}
          </span>
        )}
      </button>

      {/* Account menu */}
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Account menu"
          className="rounded-sm"
        >
          <Avatar initials={initials} className="cursor-pointer" />
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-2 w-56 bg-card border border-border rounded-xl shadow-md z-50 py-1"
          >
            <div className="px-3 py-2 border-b border-border">
              <div className="text-xs font-medium text-foreground">Account</div>
              <div className="text-[10px] text-muted-foreground font-mono truncate">
                {session?.account_id ?? "Not signed in"}
              </div>
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                router.push("/settings");
              }}
              className="w-full text-left px-3 py-2 text-xs text-foreground hover:bg-secondary transition-colors"
            >
              Settings
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void signOut()}
              className="w-full text-left px-3 py-2 text-xs text-destructive hover:bg-destructive/10 transition-colors"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
