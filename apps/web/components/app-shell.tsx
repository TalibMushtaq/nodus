"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { TopBar } from "./topbar";

// The complete app shell: sidebar + topbar + main content slot. The shell
// holds only the sidebar-collapse state; page routing is URL-based (Next.js
// App Router) so deep-linking and the back button work as expected.

const pageTitles: Record<string, string> = {
  overview: "Overview",
  devices: "Devices",
  security: "Security",
  settings: "Settings",
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  const page = pathname.split("/").filter(Boolean)[0] || "overview";

  return (
    <div className="flex h-full overflow-hidden bg-background">
      <Sidebar collapsed={collapsed} onCollapse={() => setCollapsed(!collapsed)} />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar title={pageTitles[page] || page} />
        <main className="flex-1 overflow-auto bg-background">{children}</main>
      </div>
    </div>
  );
}