"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Section } from "@repo/ui/primitives/section";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { Button } from "@repo/ui/primitives/button";
import { ConfirmDialog } from "@repo/ui/primitives/overlay";
import { Icon } from "@repo/ui/primitives/icons";

import {
  listTransfers,
  clearTransfers,
  type TransferLogEntry,
  type TransferOutcome,
} from "../../../lib/transfer-log";
import { timeAgo } from "../../../lib/format";

// Activity is scoped to *this device*: the Relay has no historical activity
// endpoint, so this renders the local transfer log the Files page writes. The
// copy below makes that scope explicit so it is not mistaken for account-wide
// history.

type ActivityFilter = "all" | "upload" | "download" | "failed";

const FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "upload", label: "Uploads" },
  { value: "download", label: "Downloads" },
  { value: "failed", label: "Failed" },
];

function eventLabel(entry: TransferLogEntry): string {
  if (entry.outcome === "failed") return entry.kind === "upload" ? "Upload failed" : "Download failed";
  if (entry.outcome === "in-progress") return entry.kind === "upload" ? "Uploading" : "Downloading";
  return entry.kind === "upload" ? "Uploaded" : "Downloaded";
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
    <div className="space-y-6 p-6">
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
        <div className="flex flex-wrap items-center gap-1.5 mb-3" role="group" aria-label="Filter activity">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilter(option.value)}
              aria-pressed={filter === option.value}
              className={`px-2.5 py-1 text-xs border transition-colors ${
                filter === option.value
                  ? "border-accent/40 text-accent bg-accent/10"
                  : "border-border text-muted-foreground hover:text-foreground"
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
            title={entries.length === 0 ? "No transfers yet" : "Nothing matches this filter"}
            description={
              entries.length === 0
                ? "Uploads and downloads from this browser will show up here."
                : "Try a different filter."
            }
          />
        ) : (
          <div className="border border-border rounded-xl overflow-hidden bg-card">
            {visible.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-3 px-5 py-3.5 border-b border-border last:border-0"
              >
                <span className="text-muted-foreground shrink-0">
                  <Icon name={entry.kind === "upload" ? "upload" : "download"} size={14} />
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
