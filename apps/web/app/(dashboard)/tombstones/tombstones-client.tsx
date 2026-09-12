"use client";

import { useCallback, useEffect, useState } from "react";
import { Section } from "@repo/ui/primitives/section";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { Button } from "@repo/ui/primitives/button";
import { ConfirmDialog } from "@repo/ui/primitives/overlay";
import { Icon } from "@repo/ui/primitives/icons";
import { decryptName } from "@repo/core";
import { identityPrivateKey } from "@repo/relay-client";
import type { StoredDeviceIdentity } from "@repo/relay-client";

import { useTombstones } from "../../../lib/use-tombstones";
import {
  purgeTombstone,
  restoreTombstone,
  tombstoneStatus,
  type TombstoneEntityType,
  type TombstoneItem,
} from "../../../lib/tombstones";
import { getFileKey } from "../../../lib/keys";
import { fetchAndOpenFileKey } from "../../../lib/envelopes";
import { shortId } from "../../../lib/format";
import { logTransferAction } from "../../../lib/transfer-log";
import { useAuth } from "../../../providers/auth-provider";

// Tombstone = the soft-delete view. Deleted files/folders stay here until
// restored or permanently purged (or the 90-day retention window elapses).
// Per-node status shows delete/purge progress across the Relay and Storage Nodes.

const TONE_COLOR: Record<"pending" | "synced" | "offline", string> = {
  synced: "var(--status-synced)",
  pending: "var(--status-pending)",
  offline: "var(--status-offline)",
};

async function resolveName(item: TombstoneItem, device: StoredDeviceIdentity | null): Promise<string> {
  // Folder names have no key path on the web client yet, so show a short id.
  if (item.entity_type === "folder") return `Folder · ${shortId(item.entity_id)}`;
  if (!item.encrypted_name) return shortId(item.entity_id);
  let fek = await getFileKey(item.entity_id);
  if (!fek && device) {
    try {
      fek = (await fetchAndOpenFileKey(item.entity_id, device.device_id, identityPrivateKey(device))) ?? undefined;
    } catch {
      fek = undefined;
    }
  }
  if (!fek) return `Encrypted · ${shortId(item.entity_id)}`;
  try {
    return decryptName(item.encrypted_name, fek);
  } catch {
    return shortId(item.entity_id);
  }
}

function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
}

export function TombstonesClient() {
  const { device } = useAuth();
  const { items, loading, error, refresh } = useTombstones();
  const [names, setNames] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<TombstoneItem | null>(null);

  // Decrypt display names once per item set. Failures fall back to a short id
  // inside resolveName, so this never blocks rendering.
  useEffect(() => {
    let cancelled = false;
    Promise.all(items.map(async (item) => [item.entity_id, await resolveName(item, device)] as const)).then(
      (pairs) => {
        if (!cancelled) setNames(Object.fromEntries(pairs));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [items, device]);

  const keyOf = (item: TombstoneItem) => `${item.entity_type}:${item.entity_id}`;

  const restore = useCallback(
    async (item: TombstoneItem) => {
      setBusyKey(keyOf(item));
      setActionError(null);
      const displayName = names[item.entity_id] ?? shortId(item.entity_id);
      try {
        await restoreTombstone(item.entity_type as TombstoneEntityType, item.entity_id);
        await logTransferAction({
          kind: "restore",
          fileId: item.entity_id,
          fileName: displayName,
          outcome: "complete",
          detail: "Restored from Tombstone",
        });
        refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setActionError(message);
        await logTransferAction({
          kind: "restore",
          fileId: item.entity_id,
          fileName: displayName,
          outcome: "failed",
          detail: message,
        });
      } finally {
        setBusyKey(null);
      }
    },
    [refresh, names],
  );

  const confirmPurge = useCallback(async () => {
    if (!purgeTarget) return;
    setBusyKey(keyOf(purgeTarget));
    setActionError(null);
    const displayName = names[purgeTarget.entity_id] ?? shortId(purgeTarget.entity_id);
    try {
      await purgeTombstone(purgeTarget.entity_type as TombstoneEntityType, purgeTarget.entity_id);
      await logTransferAction({
        kind: "delete",
        fileId: purgeTarget.entity_id,
        fileName: displayName,
        outcome: "complete",
        detail: "Permanently deleted",
      });
      setPurgeTarget(null);
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionError(message);
      await logTransferAction({
        kind: "delete",
        fileId: purgeTarget.entity_id,
        fileName: displayName,
        outcome: "failed",
        detail: message,
      });
    } finally {
      setBusyKey(null);
    }
  }, [purgeTarget, refresh, names]);

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
      {actionError && (
        <p className="text-xs text-destructive" role="alert">
          {actionError}
        </p>
      )}

      <Section
        title="Tombstone"
        action={
          <Button variant="secondary" size="sm" onClick={refresh}>
            Refresh
          </Button>
        }
      >
        {loading ? (
          <p className="text-xs text-muted-foreground px-1">Loading tombstones…</p>
        ) : items.length === 0 ? (
          <EmptyState
            title="Tombstone is empty"
            description="Deleted files and folders appear here until restored or permanently deleted."
          />
        ) : (
          <div className="border border-border rounded-xl overflow-hidden bg-card">
            {items.map((item) => {
              const status = tombstoneStatus(item);
              const busy = busyKey === keyOf(item);
              return (
                <div
                  key={keyOf(item)}
                  className="flex items-center gap-4 px-5 py-3.5 border-b border-border last:border-0 hover:bg-secondary/40 transition-colors"
                >
                  <span className="text-muted-foreground shrink-0">
                    <Icon name="trash" size={15} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {names[item.entity_id] ?? shortId(item.entity_id)}
                      </span>
                      <span
                        className="inline-flex items-center gap-1.5 text-[11px] font-medium shrink-0"
                        style={{ color: TONE_COLOR[status.tone] }}
                      >
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: TONE_COLOR[status.tone] }}
                        />
                        {status.label}
                      </span>
                    </div>
                    <div className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">
                      {item.entity_type} · purges in {daysUntil(item.purge_after)} day
                      {daysUntil(item.purge_after) === 1 ? "" : "s"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void restore(item)}
                    disabled={busy}
                    className="px-3 py-1.5 text-xs border border-border text-foreground hover:border-accent hover:text-accent transition-colors shrink-0 disabled:opacity-40"
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={() => setPurgeTarget(item)}
                    disabled={busy}
                    className="px-3 py-1.5 text-xs border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors shrink-0 disabled:opacity-40"
                  >
                    Delete permanently
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {purgeTarget && (
        <ConfirmDialog
          title="Delete permanently"
          destructive
          busy={busyKey === keyOf(purgeTarget)}
          confirmLabel="Delete permanently"
          description={
            <>
              Permanently delete “{names[purgeTarget.entity_id] ?? shortId(purgeTarget.entity_id)}”? The
              data is removed from the Relay and every Storage Node. This cannot be undone.
            </>
          }
          onConfirm={() => void confirmPurge()}
          onClose={() => setPurgeTarget(null)}
        />
      )}
    </div>
  );
}
