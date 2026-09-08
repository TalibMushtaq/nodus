"use client";

import { Icon } from "@repo/ui/primitives/icons";
import { Avatar } from "@repo/ui/primitives/brand";
import { useTheme } from "../providers/theme-provider";

// The persistent top bar: page title, search, +New, notifications, theme
// toggle, and avatar. Uses the warm surface gradient on light and its dark twin.

interface TopBarProps {
  title: string;
  showNew?: boolean;
  onNew?: () => void;
}

export function TopBar({ title, showNew = false, onNew }: TopBarProps) {
  const { theme, setTheme, resolvedDark } = useTheme();

  const cycleTheme = () => {
    const order = ["light", "dark", "system"] as const;
    const idx = order.indexOf(theme);
    const next = order[(idx + 1) % order.length] ?? "system";
    setTheme(next);
  };

  return (
    <header className="h-13 flex items-center gap-4 px-5 border-b border-border shrink-0 topbar-warm">
      <h1 className="text-sm font-semibold text-foreground flex-1">{title}</h1>

      {/* Search */}
      <div className="relative hidden sm:flex items-center">
        <Icon name="search" size={13} className="absolute left-2.5 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search files, devices\u2026"
          className="pl-8 pr-3 py-1.5 text-xs bg-secondary border border-border rounded-sm text-foreground placeholder-muted-foreground outline-none focus:border-accent w-48"
        />
      </div>

      {/* + New */}
      {showNew && (
        <button type="button" onClick={onNew} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent text-accent-foreground rounded-sm hover:opacity-90 transition-opacity">
          <Icon name="plus" size={12} />
          New
        </button>
      )}

      {/* Notifications */}
      <button type="button" className="relative text-muted-foreground hover:text-foreground transition-colors">
        <Icon name="bell" size={16} />
        <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-accent rounded-full" />
      </button>

      {/* Theme toggle */}
      <button
        type="button"
        onClick={cycleTheme}
        className="text-muted-foreground hover:text-foreground transition-colors"
        title={`Current: ${theme}${theme === "system" ? ` (${resolvedDark ? "dark" : "light"})` : ""}`}
      >
        <Icon name={resolvedDark ? "sun" : "moon"} size={16} />
      </button>

      {/* Avatar */}
      <Avatar initials="AK" className="cursor-pointer" />
    </header>
  );
}