"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Section } from "@repo/ui/primitives/section";
import { PageHeader } from "@repo/ui/primitives/page-header";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { DeviceStateBadge } from "@repo/ui/primitives/badge";
import { ConfirmDialog } from "@repo/ui/primitives/overlay";
import { Icon } from "@repo/ui/primitives/icons";

import { listDevices, listNodes, revokeDevice, type RelayDevice, type RelayNode } from "../../../lib/pairing";
import {
  exportEnvelopes,
  fetchEnvelopeSummary,
  type EnvelopeSummary,
} from "../../../lib/envelopes";
import { envelopeRows, deviceLastActive } from "../../../lib/security";
import { shortId, timeAgo } from "../../../lib/format";
import { useAuth } from "../../../providers/auth-provider";
import { RecoveryCard } from "./recovery-card";

// Security page: per-recipient key-envelope coverage, an offline ciphertext
// backup of those envelopes, and the real device-revocation list. Every section
// is backed by a Relay read/write path; the recovery-key section lands with the
// ADR-0002 work (it needs a real account recovery identity, not a mock).

export default function SecurityPage() {
  const router = useRouter();
  const { session, logout } = useAuth();
  const [devices, setDevices] = useState<RelayDevice[]>([]);
  const [nodes, setNodes] = useState<RelayNode[]>([]);
  const [summaries, setSummaries] = useState<EnvelopeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [envelopesOpen, setEnvelopesOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // The device awaiting confirmation, plus in-flight state for the dialog.
  const [revokeTarget, setRevokeTarget] = useState<RelayDevice | null>(null);
  const [revoking, setRevoking] = useState(false);

  // Initial load; loading starts true so the effect body performs no synchronous
  // setState (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    Promise.all([listDevices(), listNodes(), fetchEnvelopeSummary()])
      .then(([d, n, s]) => {
        if (cancelled) return;
        setDevices(d);
        setNodes(n);
        setSummaries(s);
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

  const rows = useMemo(() => envelopeRows(summaries, devices, nodes), [summaries, devices, nodes]);

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
      // Re-fetch so the revoked device's envelopes drop out of coverage and the
      // row flips to its revoked state immediately.
      const [d, s] = await Promise.all([listDevices(), fetchEnvelopeSummary()]);
      setDevices(d);
      setSummaries(s);
      setRevokeTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevoking(false);
    }
  }, [revokeTarget, session, logout, router]);

  const downloadBackup = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    try {
      const backup = await exportEnvelopes();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `nodus-key-envelopes-${backup.account_id.slice(0, 8)}-${backup.generated_at.slice(0, 10)}.json`;
      anchor.click();
      // Defer the revoke so the browser finishes initiating the download; some
      // engines abort the transfer if the URL is revoked synchronously.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, []);

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <PageHeader
        eyebrow="Trust"
        title="Security"
        description="Recovery identity, per-device key coverage, and device revocation."
      />

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Recovery key (ADR-0002) */}
      <RecoveryCard />

      {/* Key envelopes */}
      <Section
        title="Key envelopes"
        action={
          rows.length > 0 ? (
            <button
              type="button"
              onClick={() => setEnvelopesOpen((open) => !open)}
              aria-expanded={envelopesOpen}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              {envelopesOpen ? "Collapse" : "Expand"}
              <Icon name="chevron-down" size={10} className={envelopesOpen ? "rotate-180 transition-transform" : "transition-transform"} />
            </button>
          ) : undefined
        }
      >
        {loading ? (
          <p className="text-xs text-muted-foreground px-1">Loading key envelopes…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="lock"
            title="No key envelopes yet"
            description="Each device and node gets an envelope for every file's key when a file is uploaded."
          />
        ) : (
          <>
            <div className="bg-card border border-border rounded-2xl overflow-hidden elev-card">
              <p className="px-4 py-3 text-xs text-muted-foreground border-b border-border">
                Each device holds an encrypted copy of each file&apos;s encryption key. The relay
                stores these envelopes but cannot decrypt them.
              </p>
              {envelopesOpen && (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-secondary border-b border-border">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Device</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Device ID</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Files covered</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Folders covered</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Last updated</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {rows.map((row) => (
                        <tr key={row.key} className="hover:bg-secondary/40">
                          <td className="px-4 py-2.5 text-sm text-foreground">{row.name}</td>
                          <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{shortId(row.id)}</td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">{row.fileCount}</td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">{row.folderCount}</td>
                          <td className="px-4 py-2.5 text-xs font-mono text-muted-foreground">
                            {row.lastUpdated ? timeAgo(row.lastUpdated) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="mt-2">
              <button
                type="button"
                onClick={() => void downloadBackup()}
                disabled={exporting}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                <Icon name="download" size={12} />
                {exporting ? "Preparing backup…" : "Download encrypted backup of key envelopes"}
              </button>
              {exportError && <p className="text-xs text-destructive mt-1">{exportError}</p>}
            </div>
          </>
        )}
      </Section>

      {/* Device revocation */}
      <Section title="Device revocation">
        {loading ? (
          <p className="text-xs text-muted-foreground px-1">Loading devices…</p>
        ) : devices.length === 0 ? (
          <EmptyState
            icon="phone"
            title="No paired devices"
            description="Devices are registered here when they pair with a Storage Node."
          />
        ) : (
          <div className="border border-border rounded-2xl overflow-hidden bg-card divide-y divide-border elev-card">
            {devices.map((d) => {
              const revoked = d.status === "REVOKED";
              return (
                <div key={d.device_id} className="flex items-center gap-4 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-sm truncate ${revoked ? "text-muted-foreground line-through" : "text-foreground"}`}
                      >
                        {d.display_name ?? shortId(d.device_id)}
                      </span>
                      <DeviceStateBadge revoked={revoked} />
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground mt-0.5 truncate">
                      {d.device_id} · {deviceLastActive(d)}
                    </div>
                  </div>
                  {!revoked && (
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
