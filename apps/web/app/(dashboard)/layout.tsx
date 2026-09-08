import type { ReactNode } from "react";
import { AppShell } from "../../components/app-shell";

// Dashboard layout wraps every page under the (dashboard) group in AppShell.
// The layout is a server component; AppShell is client.

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}