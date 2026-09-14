"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Section } from "@repo/ui/primitives/section";
import { PageHeader } from "@repo/ui/primitives/page-header";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { Button } from "@repo/ui/primitives/button";
import { Icon } from "@repo/ui/primitives/icons";

import { useConflicts } from "../../../lib/use-conflicts";
import { shortId } from "../../../lib/format";
import { conflictResolvedEvent } from "../../../lib/file-events";
import { nextOriginSequence } from "../../../lib/sync-state";
import { useEventBatch } from "../../../lib/use-event-batch";
import { useAuth } from "../../../providers/auth-provider";
import type { ConflictEntry } from "../../../lib/conflicts";

// Conflict inbox (ADR-0003). A persistent list of preserved conflicted copies
// (a version fork flagged by the Relay) — not a transient banner. "Resolve"
// emits a CONFLICT_RESOLVED event so the Relay and every Storage Node mark the
// file's flagged versions resolved and it leaves the inbox on all clients; the
// version data itself is retained.

function formatUpdated(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "—";
  return new Date(parsed).toLocaleString();
}

export function ConflictsClient() {
  const { device } = useAuth();
  const sendEventBatch = useEventBatch();
  const { conflicts, loading, error, refresh } = useConflicts();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const resolve = useCallback(
    async (conflict: ConflictEntry) => {
      if (!device) return;
      setBusy(conflict.fileId);
      setActionError(null);
      try {
        const sequence = await nextOriginSequence(device.device_id);
        const ack = await sendEventBatch([
          conflictResolvedEvent(device.device_id, sequence, conflict.fileId),
        ]);
        if (ack && ack.ok === false) {
          throw new Error(ack.reason ?? "unknown");
        }
        refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [device, sendEventBatch, refresh],
  );

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6">
      <PageHeader
        eyebrow="Reconciliation"
        title="Conflicts"
        description="Preserved version forks from offline edits. Nothing is discarded until you resolve it."
      />

      {error && (
        <div className="flex items-center gap-3" role="alert">
          <p className="text-xs text-destructive">{error}</p>
          <Button variant="secondary" size="sm" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}
      {actionError && (
        <p className="text-xs text-destructive" role="alert">
          {actionError}
        </p>
      )}

      <Section
        title="Conflicts"
        action={
          <Button variant="secondary" size="sm" onClick={refresh}>
            Refresh
          </Button>
        }
      >
        {loading ? (
          <p className="text-xs text-muted-foreground px-1">Loading conflicts…</p>
        ) : conflicts.length === 0 ? (
          <EmptyState
            icon="copy"
            title="No conflicts"
            description="When two devices edit the same file offline, both versions are kept and appear here until you resolve them."
          />
        ) : (
          <div className="border border-border rounded-2xl overflow-hidden bg-card elev-card">
            {conflicts.map((conflict) => (
              <div
                key={conflict.fileId}
                className="flex items-center gap-4 px-5 py-3.5 border-b border-border last:border-0 hover:bg-secondary/40 transition-colors"
              >
                <span className="text-muted-foreground shrink-0">
                  <Icon name="copy" size={15} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate">
                      {conflict.name}
                    </span>
                    <span
                      className="inline-flex items-center gap-1.5 text-[11px] font-medium shrink-0"
                      style={{ color: "var(--status-pending)" }}
                    >
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: "var(--status-pending)" }}
                      />
                      Conflicted copy
                    </span>
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">
                    {shortId(conflict.fileId)} · version{conflict.versions.length === 1 ? "" : "s"}{" "}
                    {conflict.versions.join(", ")} · updated {formatUpdated(conflict.updatedAt)}
                  </div>
                </div>
                <Link
                  href="/files"
                  className="px-3 py-1.5 text-xs border border-border text-foreground hover:border-accent hover:text-accent transition-colors shrink-0"
                >
                  Open in Files
                </Link>
                <button
                  type="button"
                  onClick={() => void resolve(conflict)}
                  disabled={busy === conflict.fileId}
                  className="px-3 py-1.5 text-xs border border-border text-foreground hover:border-accent hover:text-accent transition-colors shrink-0 disabled:opacity-40"
                >
                  {busy === conflict.fileId ? "Resolving…" : "Resolve"}
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <p className="text-xs text-muted-foreground px-1">
        Conflicted copies are kept as siblings so no edit is lost. Resolve marks the
        conflict as handled on every device; open the file in Files to download the
        version you want to keep.
      </p>
    </div>
  );
}

