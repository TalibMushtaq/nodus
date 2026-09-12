"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Section } from "@repo/ui/primitives/section";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { DeviceStateBadge } from "@repo/ui/primitives/badge";
import { ConfirmDialog } from "@repo/ui/primitives/overlay";

import { listDevices, revokeDevice, type RelayDevice } from "../../../lib/pairing";
import { shortId, timeAgo } from "../../../lib/format";
import { useAuth } from "../../../providers/auth-provider";

// Security / paired devices. The recovery-seed, key-envelope, and topology
// sections had no backend read path (the Relay only catalogs devices) and were
// mock-only — removed. Revoke hits the real Relay DELETE /devices/{id}, which
// also removes the device's key envelopes and kills its sessions, so it is
// gated behind a confirmation; revoking the current device signs the user out.

export default function SecurityPage() {
  const router = useRouter();
  const { session, logout } = useAuth();
  const [devices, setDevices] = useState<RelayDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The device awaiting confirmation, plus in-flight state for the dialog.
  const [revokeTarget, setRevokeTarget] = useState<RelayDevice | null>(null);
  const [revoking, setRevoking] = useState(false);

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

  const confirmRevoke = useCallback(async () => {
    if (!revokeTarget) return;
    const id = revokeTarget.device_id;
    setRevoking(true);
    setError(null);
    try {
      await revokeDevice(id);
      // Revoking the signed-in device ends its own session: leave for /auth
      // instead of rendering a page whose API calls will now 401.
      if (id === session?.device_id) {
        await logout();
        router.push("/auth");
        return;
      }
      // Re-fetch so revoked devices drop out of the active set immediately.
      setDevices(await listDevices());
      setRevokeTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevoking(false);
    }
  }, [revokeTarget, session, logout, router]);

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
                      <DeviceStateBadge revoked={revoked} />
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
                      onClick={() => setRevokeTarget(d)}
                      disabled={revoking && revokeTarget?.device_id === d.device_id}
                      className="px-3 py-1.5 text-xs border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors shrink-0 disabled:opacity-50"
                    >
                      {revoking && revokeTarget?.device_id === d.device_id ? "Revoking…" : "Revoke"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {revokeTarget && (
        <ConfirmDialog
          title="Revoke device"
          destructive
          busy={revoking}
          confirmLabel="Revoke device"
          description={
            revokeTarget.device_id === session?.device_id ? (
              <>
                <strong className="text-foreground">This is the device you are signed in on.</strong>{" "}
                Revoking it signs you out and permanently removes its sessions and key envelopes.
              </>
            ) : (
              <>
                This permanently removes the device, its sessions, and its key envelopes. It
                cannot be undone.
              </>
            )
          }
          onConfirm={() => void confirmRevoke()}
          onClose={() => setRevokeTarget(null)}
        />
      )}
    </div>
  );
}
