"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Section } from "@repo/ui/primitives/section";
import { PageHeader } from "@repo/ui/primitives/page-header";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { Button } from "@repo/ui/primitives/button";
import { ConfirmDialog } from "@repo/ui/primitives/overlay";
import { Icon } from "@repo/ui/primitives/icons";
import { PathIndicator } from "@repo/ui/primitives/path-indicator";

import {
  listTransfers,
  clearTransfers,
  type TransferKind,
  type TransferLogEntry,
  type TransferOutcome,
} from "../../../lib/transfer-log";
import { timeAgo } from "../../../lib/format";
import type { IconName } from "@repo/ui/primitives/icons";

// Activity is scoped to *this device*: the Relay has no historical activity
// endpoint, so this renders the local action log the Files/Tombstone pages
// write. The copy below makes that scope explicit so it is not mistaken for
// account-wide history.

type ActivityFilter = "all" | TransferKind | "failed";

const FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "upload", label: "Uploads" },
  { value: "download", label: "Downloads" },
  { value: "delete", label: "Deletes" },
  { value: "restore", label: "Restores" },
  { value: "failed", label: "Failed" },
];

const LABELS: Record<TransferKind, { complete: string; progress: string; failed: string }> = {
  upload: { complete: "Uploaded", progress: "Uploading", failed: "Upload failed" },
  download: { complete: "Downloaded", progress: "Downloading", failed: "Download failed" },
  delete: { complete: "Deleted", progress: "Deleting", failed: "Delete failed" },
  restore: { complete: "Restored", progress: "Restoring", failed: "Restore failed" },
};

const ICONS: Record<TransferKind, IconName> = {
  upload: "upload",
  download: "download",
  delete: "trash",
  restore: "refresh",
};

function eventLabel(entry: TransferLogEntry): string {
  const labels = LABELS[entry.kind];
  if (entry.outcome === "failed") return labels.failed;
  if (entry.outcome === "in-progress") return labels.progress;
  return labels.complete;
}

function OutcomeChip({ outcome }: { outcome: TransferOutcome }) {
  if (outcome === "complete") {
    return <span className="text-[10px] font-mono" style={{ color: "var(--status-synced)" }}>Complete</span>;
  }
  if (outcome === "failed") {
    return <span className="text-[10px] font-mono" style={{ color: "var(--status-conflict)" }}>Failed</span>;
  }
  return (
    <span
      className="text-[10px] font-mono inline-flex items-center gap-1"
      style={{ color: "var(--status-pending)" }}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse inline-block" />
      In progress
    </span>
  );
}

export function ActivityClient() {
  const [entries, setEntries] = useState<TransferLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listTransfers().then((rows) => {
      if (cancelled) return;
      setEntries(rows);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    if (filter === "all") return entries;
    if (filter === "failed") return entries.filter((entry) => entry.outcome === "failed");
    return entries.filter((entry) => entry.kind === filter);
  }, [entries, filter]);

  const clear = useCallback(async () => {
    setClearing(true);
    try {
      await clearTransfers();
      setEntries([]);
      setConfirmClear(false);
    } finally {
      setClearing(false);
    }
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6">
      <PageHeader
        eyebrow="Timeline"
        title="Activity"
        description="Uploads, downloads, deletes, and restores recorded by this browser."
      />

      <Section
        title="Activity · this device"
        action={
          entries.length > 0 ? (
            <Button variant="secondary" size="sm" onClick={() => setConfirmClear(true)}>
              Clear
            </Button>
          ) : undefined
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter activity">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilter(option.value)}
              aria-pressed={filter === option.value}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                filter === option.value
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-border text-muted-foreground hover:border-accent/30 hover:text-foreground"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-xs text-muted-foreground px-1">Loading activity…</p>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="activity"
            title={entries.length === 0 ? "No activity yet" : "Nothing matches this filter"}
            description={
              entries.length === 0
                ? "Uploads, downloads, deletes, and restores from this browser will show up here."
                : "Try a different filter."
            }
          />
        ) : (
          <div className="border border-border rounded-2xl overflow-hidden bg-card elev-card">
            {visible.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-3 px-5 py-3.5 border-b border-border last:border-0"
              >
                <span className="text-muted-foreground shrink-0">
                  <Icon name={ICONS[entry.kind]} size={14} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-foreground truncate">
                    <span className="text-muted-foreground">{eventLabel(entry)}</span>{" "}
                    {entry.fileName}
                  </div>
                  {entry.detail && (
                    <div className="text-[10px] text-muted-foreground truncate">{entry.detail}</div>
                  )}
                </div>
                {/* Path is only present for entries logged after transfer-path
                    capture shipped; older delete/restore rows have none. */}
                {entry.path && <PathIndicator path={entry.path} />}
                <OutcomeChip outcome={entry.outcome} />
                <div className="text-[10px] font-mono text-muted-foreground shrink-0">{timeAgo(entry.at)}</div>
              </div>
            ))}
          </div>
        )}

        <p className="text-[10px] text-muted-foreground mt-3">
          Local to this browser. Account-wide history is not synced by the Relay yet.
        </p>
      </Section>

      {confirmClear && (
        <ConfirmDialog
          title="Clear activity log"
          destructive
          busy={clearing}
          confirmLabel="Clear log"
          description="This removes the transfer history stored in this browser. It does not affect your files."
          onConfirm={() => void clear()}
          onClose={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}
