"use client";

import { useCallback, useEffect, useState } from "react";
import { Section } from "@repo/ui/primitives/section";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { StatusBadge } from "@repo/ui/primitives/badge";

import { listDevices, revokeDevice, type RelayDevice } from "../../../lib/pairing";
import { shortId, timeAgo } from "../../../lib/format";

// Security / paired devices. The recovery-seed, key-envelope, and topology
// sections had no backend read path (the Relay only catalogs devices) and were
// mock-only — removed. Revoke hits the real Relay DELETE /devices/{id}, which
// also removes the device's key envelopes and kills its sessions.

export default function SecurityPage() {
  const [devices, setDevices] = useState<RelayDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // Initial load; loading starts true so the effect body performs no synchronous
  // setState (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    listDevices()
      .then((d) => {
        if (cancelled) return;
        setDevices(d);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const revoke = useCallback(async (id: string) => {
    setRevokingId(id);
    setError(null);
    try {
      await revokeDevice(id);
      // Re-fetch so revoked devices drop out of the active set immediately.
      setDevices(await listDevices());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevokingId(null);
    }
  }, []);

  return (
    <div className="space-y-6 p-6">
      {error && <p className="text-xs text-destructive">{error}</p>}

      <Section title="Paired devices">
        {loading ? (
          <p className="text-xs text-muted-foreground px-1">Loading devices…</p>
        ) : devices.length === 0 ? (
          <EmptyState
            title="No paired devices"
            description="Devices are registered here when they pair with a Storage Node."
          />
        ) : (
          <div className="border border-border rounded-xl overflow-hidden bg-card">
            <div className="px-5 py-3 border-b border-border">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Device Registry</h3>
            </div>
            {devices.map((d) => {
              const revoked = d.status === "REVOKED";
              return (
                <div key={d.device_id} className="flex items-center gap-4 px-5 py-3.5 border-b border-border last:border-0 hover:bg-secondary/40 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-foreground font-mono font-medium">{shortId(d.device_id)}</span>
                      <StatusBadge
                        status={revoked ? "offline" : "synced"}
                        variant="inline"
                      />
                    </div>
                    <div className="text-[10px] font-mono text-muted-foreground mt-0.5">{d.device_id}</div>
                  </div>
                  <div className="text-[10px] text-muted-foreground hidden sm:block">
                    {revoked ? `Revoked ${timeAgo(d.revoked_at)}` : `Registered ${timeAgo(d.created_at)}`}
                  </div>
                  {revoked ? (
                    <span className="text-[10px] text-muted-foreground shrink-0">Revoked</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void revoke(d.device_id)}
                      disabled={revokingId === d.device_id}
                      className="px-3 py-1.5 text-xs border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors shrink-0 disabled:opacity-50"
                    >
                      {revokingId === d.device_id ? "Revoking…" : "Revoke"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}