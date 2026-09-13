"use client";

import Link from "next/link";
import { Section } from "@repo/ui/primitives/section";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { Button } from "@repo/ui/primitives/button";
import { Icon } from "@repo/ui/primitives/icons";

import { useConflicts } from "../../../lib/use-conflicts";
import { shortId } from "../../../lib/format";

// Conflict inbox (ADR-0003). A persistent list of preserved conflicted copies
// (a version fork flagged by the Relay) — not a transient banner. The user
// resolves a conflict from the Files view by downloading/keeping one copy; this
// screen makes sure the backlog is never missed.

function formatUpdated(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "—";
  return new Date(parsed).toLocaleString();
}

export function ConflictsClient() {
  const { conflicts, loading, error, refresh } = useConflicts();

  return (
    <div className="space-y-6 p-6">
      {error && (
        <div className="flex items-center gap-3" role="alert">
          <p className="text-xs text-destructive">{error}</p>
          <Button variant="secondary" size="sm" onClick={refresh}>
            Retry
          </Button>
        </div>
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
            title="No conflicts"
            description="When two devices edit the same file offline, both versions are kept and appear here until you resolve them."
          />
        ) : (
          <div className="border border-border rounded-xl overflow-hidden bg-card">
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
                  Resolve in Files
                </Link>
              </div>
            ))}
          </div>
        )}
      </Section>

      <p className="text-xs text-muted-foreground px-1">
        Conflicted copies are kept as siblings so no edit is lost. Open the file in
        Files, keep the version you want, then delete the other copy.
      </p>
    </div>
  );
}
