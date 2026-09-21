import type { ReactNode } from "react";
import { AppShell } from "../../components/app-shell";
import { TransferProvider } from "../../providers/transfer-provider";
import { UploadProvider } from "../../providers/upload-provider";
import { DownloadProvider } from "../../providers/download-provider";
import { ActivityProvider } from "../../providers/activity-provider";
import { NotificationProvider } from "../../providers/notification-provider";
import { requireAuth } from "../../lib/session";

// Dashboard layout wraps every page under the (dashboard) group in AppShell.
// Phase 7a §3: the group now requires a valid session — the guard runs server
// side before AppShell (a client component) renders.

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  await requireAuth();
  return (
    <TransferProvider>
      {/* NotificationProvider mirrors the user's alert toggles, registers the
          notification service worker, and watches for new conflicts across every
          page. Outermost so its conflict watcher and module state are live for
          the whole session. */}
      <NotificationProvider>
        {/* UploadProvider owns the queue + floating widget, so an upload started
            on Files keeps showing progress after navigating to another page. */}
        <UploadProvider>
          {/* DownloadProvider owns the download widget so a download started on
              Files keeps showing stage progress after navigating away. */}
          <DownloadProvider>
            {/* ActivityProvider syncs locally-recorded activity to the account-wide
                feed (Relay/Node) in the background, independent of the page. */}
            <ActivityProvider>
              <AppShell>{children}</AppShell>
            </ActivityProvider>
          </DownloadProvider>
        </UploadProvider>
      </NotificationProvider>
    </TransferProvider>
  );
}