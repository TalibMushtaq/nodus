import type { ReactNode } from "react";
import { AppShell } from "../../components/app-shell";
import { TransferProvider } from "../../providers/transfer-provider";
import { UploadProvider } from "../../providers/upload-provider";
import { requireAuth } from "../../lib/session";

// Dashboard layout wraps every page under the (dashboard) group in AppShell.
// Phase 7a §3: the group now requires a valid session — the guard runs server
// side before AppShell (a client component) renders.

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  await requireAuth();
  return (
    <TransferProvider>
      {/* UploadProvider owns the queue + floating widget, so an upload started
          on Files keeps showing progress after navigating to another page. */}
      <UploadProvider>
        <AppShell>{children}</AppShell>
      </UploadProvider>
    </TransferProvider>
  );
}