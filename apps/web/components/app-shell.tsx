"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { TopBar } from "./topbar";
import { TransferPathBanner } from "./transfer-path-banner";

// The complete app shell: sidebar + topbar + main content slot. Routing is
// URL-based (Next.js App Router) so deep-linking and the back button work.
//
// Responsive behavior: from `md` up the sidebar is a static column that can
// collapse; below `md` it is an off-canvas drawer opened from the topbar so the
// content is no longer squeezed by a fixed 224px rail on phones.

const COLLAPSE_KEY = "nodus.sidebar.collapsed";

const pageTitles: Record<string, string> = {
  overview: "Overview",
  files: "Files",
  tombstones: "Tombstone",
  devices: "Devices",
  activity: "Activity",
  security: "Security",
  settings: "Settings",
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  const page = pathname.split("/").filter(Boolean)[0] || "overview";

  // Restore the desktop collapse choice after mount (localStorage is not
  // available during SSR, so reading it during render would desync hydration).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate post-SSR bootstrap
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);

  // Close the mobile drawer whenever the route changes (a nav tap otherwise
  // leaves it covering the new page).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- close the drawer in response to navigation (external URL change)
    setMobileOpen(false);
  }, [pathname]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  return (
    <div className="flex h-full overflow-hidden bg-background">
      {/* Desktop rail */}
      <div className="hidden md:flex">
        <Sidebar collapsed={collapsed} onCollapse={toggleCollapsed} />
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="presentation">
          <div
            className="absolute inset-0 bg-foreground/30 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute inset-y-0 left-0">
            <Sidebar collapsed={false} onCollapse={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar title={pageTitles[page] || page} onMenuClick={() => setMobileOpen(true)} />
        <TransferPathBanner />
        <main className="flex-1 overflow-auto bg-background">{children}</main>
      </div>
    </div>
  );
}
