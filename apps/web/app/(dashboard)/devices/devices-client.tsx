"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@repo/ui/primitives/button";
import { Section } from "@repo/ui/primitives/section";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { StatusBadge } from "@repo/ui/primitives/badge";

import { listNodes, listDevices, revokeDevice, type RelayNode, type RelayDevice } from "../../../lib/pairing";
import { shortId, timeAgo } from "../../../lib/format";
import { AddStorageNodeDialog } from "../../../components/add-storage-node-dialog";

// Real-device readout: storage nodes and client devices come from the Relay
// (GET /nodes, GET /devices) via the session-cookie API proxies. There is no
// mock fleet — empty states render until a node/device is actually registered.
//
// `publicRelayUrl` is the operator-configured PUBLIC_RELAY_URL resolved
// server-side (never the internal RELAY_URL/localhost). The "+ Add Storage
// Node" dialog that renders it lands in S7; S6 only surfaces the unset warning.

interface DevicesClientProps {
  publicRelayUrl: string | null;
}

function NodeRowView({ node, onManage }: { node: RelayNode; onManage: () => void }) {
  const online = Boolean(node.last_seen_at);
  return (
    <div className="flex items-center gap-4 px-5 py-3.5 border-b border-border last:border-0 hover:bg-secondary/40 transition-colors">
      <div className="w-9 h-9 border border-border flex items-center justify-center shrink-0 bg-secondary">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <rect x="2" y="2" width="14" height="14" rx="1" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5 6h8M5 9h8M5 12h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground font-mono">{shortId(node.node_id)}</span>
          <StatusBadge status={online ? "synced" : "offline"} variant="inline" />
          {node.is_primary && (
            <span className="px-1.5 py-0.5 text-[9px] font-medium border border-accent/40 text-accent bg-accent/10 rounded-sm">PRIMARY</span>
          )}
        </div>
        <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
          {node.capabilities.length > 0 ? node.capabilities.join(" · ") : "storage · sync"}
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground hidden sm:block">
        {online ? `Last seen ${timeAgo(node.last_seen_at)}` : "Never seen"}
      </div>
      <button
        type="button"
        onClick={onManage}
        className="px-3 py-1.5 text-xs border border-border hover:border-accent hover:text-accent transition-colors text-foreground shrink-0"
      >
        Manage
      </button>
    </div>
  );
}

function DeviceRowView({ device, onRevoke }: { device: RelayDevice; onRevoke: () => void }) {
  const revoked = device.status === "REVOKED";
  return (
    <div className="flex items-center gap-4 px-5 py-3.5 border-b border-border last:border-0 hover:bg-secondary/40 transition-colors">
      <div className="w-9 h-9 border border-border flex items-center justify-center shrink-0 bg-secondary">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <rect x="5" y="1.5" width="8" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M7.5 4h3M9 14h0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground font-mono">{shortId(device.device_id)}</span>
          <StatusBadge status={revoked ? "offline" : "synced"} variant="inline" />
        </div>
        <div className="text-[10px] font-mono text-muted-foreground mt-0.5">{device.device_id}</div>
      </div>
      <div className="text-[10px] text-muted-foreground hidden sm:block">
        {revoked ? `Revoked ${timeAgo(device.revoked_at)}` : `Registered ${timeAgo(device.created_at)}`}
      </div>
      {revoked ? (
        <span className="text-[10px] text-muted-foreground shrink-0">Revoked</span>
      ) : (
        <button
          type="button"
          onClick={onRevoke}
          className="px-3 py-1.5 text-xs border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors shrink-0"
        >
          Revoke
        </button>
      )}
    </div>
  );
}

export function DevicesClient({ publicRelayUrl }: DevicesClientProps) {
  const router = useRouter();
  const [nodes, setNodes] = useState<RelayNode[]>([]);
  const [devices, setDevices] = useState<RelayDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Loaded once on mount; loading starts true so the effect only fires
  // setState from async callbacks (react-hooks/set-state-in-effect). The +Pair
  // buttons route to the real /pair flow instead of a static QR placeholder.
  useEffect(() => {
    let cancelled = false;
    Promise.all([listNodes(), listDevices()])
      .then(([n, d]) => {
        if (cancelled) return;
        setNodes(n);
        setDevices(d);
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
    try {
      await revokeDevice(id);
      // Re-sync the list so the just-revoked device flips to its revoked state.
      setDevices(await listDevices());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Re-sync the node catalog so a freshly paired node appears without a reload.
  const refreshNodes = useCallback(async () => {
    try {
      setNodes(await listNodes());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <div className="space-y-6 p-6">
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      {publicRelayUrl === null && (
        <p className="text-xs text-muted-foreground" data-testid="public-relay-url-missing">
          Pairing URL not configured — set <code>PUBLIC_RELAY_URL</code> on the server to
          display the relay address and CLI command.
        </p>
      )}

      {/* Storage Nodes */}
      <Section
        title="Storage nodes"
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setDialogOpen(true)}
            disabled={publicRelayUrl === null}
            title={publicRelayUrl === null ? "Set PUBLIC_RELAY_URL to pair a node" : undefined}
          >
            + Add Storage Node
          </Button>
        }
      >
        {loading ? (
          <p className="text-xs text-muted-foreground px-1">Loading nodes…</p>
        ) : nodes.length === 0 ? (
          <EmptyState
            title="No storage nodes yet"
            description="Pair a Storage Node to start syncing files across your network."
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setDialogOpen(true)}
                disabled={publicRelayUrl === null}
              >
                Add Storage Node
              </Button>
            }
          />
        ) : (
          <div className="border border-border rounded-xl overflow-hidden bg-card">
            {nodes.map((n) => (
              <NodeRowView key={n.node_id} node={n} onManage={() => router.push("/pair")} />
            ))}
          </div>
        )}
      </Section>

      {/* Client Devices */}
      <Section
        title="Client devices"
        action={<Button variant="secondary" size="sm" onClick={() => router.push("/pair")}>+ Pair device</Button>}
      >
        {loading ? (
          <p className="text-xs text-muted-foreground px-1">Loading devices…</p>
        ) : devices.length === 0 ? (
          <EmptyState
            title="No paired devices"
            description="Pair a device to sync files across your network. This browser is registered after you pair with a node on /pair."
          />
        ) : (
          <div className="border border-border rounded-xl overflow-hidden bg-card">
            {devices.map((d) => (
              <DeviceRowView key={d.device_id} device={d} onRevoke={() => void revoke(d.device_id)} />
            ))}
          </div>
        )}
      </Section>

      {dialogOpen && publicRelayUrl !== null && (
        <AddStorageNodeDialog
          relayUrl={publicRelayUrl}
          existingNodeIds={nodes.map((n) => n.node_id)}
          onClose={() => setDialogOpen(false)}
          onPaired={() => void refreshNodes()}
        />
      )}
    </div>
  );
}
