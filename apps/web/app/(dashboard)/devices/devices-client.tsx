"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@repo/ui/primitives/button";
import { Section } from "@repo/ui/primitives/section";
import { PageHeader } from "@repo/ui/primitives/page-header";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { StatusBadge, DeviceStateBadge } from "@repo/ui/primitives/badge";
import { ConfirmDialog, Modal, ModalHeader } from "@repo/ui/primitives/overlay";
import { Input } from "@repo/ui/primitives/input";

import {
  listNodes,
  listDevices,
  revokeDevice,
  renameNode,
  renameDevice,
  isNodeOnline,
  type RelayNode,
  type RelayDevice,
} from "../../../lib/pairing";
import { pingNode, pingDevice, type PingResult } from "../../../lib/ping";
import { shortId, timeAgo } from "../../../lib/format";
import { AddStorageNodeDialog } from "../../../components/add-storage-node-dialog";
import { useAuth } from "../../../providers/auth-provider";

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

// Per-peer manual ping state. Kept in the parent so a poll re-render does not
// discard a probe result.
type PingState =
  | { status: "pending" }
  | { status: "done"; result: PingResult }
  | { status: "error"; message: string };

function PingResultText({ state }: { state?: PingState }) {
  if (!state) return null;
  if (state.status === "pending") {
    return <span className="text-[10px] text-muted-foreground shrink-0">Pinging…</span>;
  }
  if (state.status === "error") {
    return <span className="text-[10px] text-destructive shrink-0">{state.message}</span>;
  }
  return state.result.online ? (
    <span className="text-[10px] shrink-0" style={{ color: "var(--status-synced)" }}>
      Reachable · {state.result.rttMs ?? 0} ms
    </span>
  ) : (
    <span className="text-[10px] text-muted-foreground shrink-0">
      {state.result.reason === "timeout" ? "No response" : "Offline"}
    </span>
  );
}

function NodeRowView({
  node,
  onManage,
  onPing,
  onRename,
  pingState,
}: {
  node: RelayNode;
  onManage: () => void;
  onPing: () => void;
  onRename: () => void;
  pingState?: PingState;
}) {
  // Staleness-derived, not "has ever been seen" (see isNodeOnline).
  const online = isNodeOnline(node);
  return (
    <div className="flex items-center gap-4 px-5 py-3.5 border-b border-border last:border-0 hover:bg-secondary/40 transition-colors">
      <div className="w-9 h-9 rounded-xl border border-border flex items-center justify-center shrink-0 bg-secondary">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <rect x="2" y="2" width="14" height="14" rx="1" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5 6h8M5 9h8M5 12h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">
            {node.display_name ?? shortId(node.node_id)}
          </span>
          <StatusBadge status={online ? "synced" : "offline"} variant="inline" />
          {node.is_primary && (
            <span className="px-1.5 py-0.5 text-[9px] font-medium border border-accent/40 text-accent bg-accent/10 rounded-sm">PRIMARY</span>
          )}
        </div>
        <div className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">
          {node.display_name ? `${shortId(node.node_id)} · ` : ""}
          {node.capabilities.length > 0 ? node.capabilities.join(" · ") : "storage · sync"}
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground hidden sm:block">
        {node.last_seen_at ? `Last seen ${timeAgo(node.last_seen_at)}` : "Never seen"}
      </div>
      <PingResultText state={pingState} />
      <button
        type="button"
        onClick={onPing}
        disabled={pingState?.status === "pending"}
        className="px-3 py-1.5 text-xs border border-border hover:border-accent hover:text-accent transition-colors text-foreground shrink-0 disabled:opacity-40"
      >
        {pingState?.status === "pending" ? "Pinging…" : "Ping"}
      </button>
      <button
        type="button"
        onClick={onRename}
        className="hidden sm:inline-block px-3 py-1.5 text-xs border border-border hover:border-accent hover:text-accent transition-colors text-foreground shrink-0"
      >
        Rename
      </button>
      <button
        type="button"
        onClick={onManage}
        className="hidden sm:inline-block px-3 py-1.5 text-xs border border-border hover:border-accent hover:text-accent transition-colors text-foreground shrink-0"
      >
        Manage
      </button>
    </div>
  );
}

function DeviceRowView({
  device,
  onRevoke,
  onPing,
  onRename,
  pingState,
}: {
  device: RelayDevice;
  onRevoke: () => void;
  onPing: () => void;
  onRename: () => void;
  pingState?: PingState;
}) {
  const revoked = device.status === "REVOKED";
  return (
    <div className="flex items-center gap-4 px-5 py-3.5 border-b border-border last:border-0 hover:bg-secondary/40 transition-colors">
      <div className="w-9 h-9 rounded-xl border border-border flex items-center justify-center shrink-0 bg-secondary">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <rect x="5" y="1.5" width="8" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M7.5 4h3M9 14h0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">
            {device.display_name ?? shortId(device.device_id)}
          </span>
          <DeviceStateBadge revoked={revoked} />
        </div>
        <div className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate">{device.device_id}</div>
      </div>
      <div className="text-[10px] text-muted-foreground hidden sm:block">
        {revoked ? `Revoked ${timeAgo(device.revoked_at)}` : `Registered ${timeAgo(device.created_at)}`}
      </div>
      {revoked ? (
        <span className="text-[10px] text-muted-foreground shrink-0">Revoked</span>
      ) : (
        <>
          <PingResultText state={pingState} />
          <button
            type="button"
            onClick={onPing}
            disabled={pingState?.status === "pending"}
            className="px-3 py-1.5 text-xs border border-border hover:border-accent hover:text-accent transition-colors text-foreground shrink-0 disabled:opacity-40"
          >
            {pingState?.status === "pending" ? "Pinging…" : "Ping"}
          </button>
          <button
            type="button"
            onClick={onRename}
            className="hidden sm:inline-block px-3 py-1.5 text-xs border border-border hover:border-accent hover:text-accent transition-colors text-foreground shrink-0"
          >
            Rename
          </button>
          <button
            type="button"
            onClick={onRevoke}
            className="px-3 py-1.5 text-xs border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors shrink-0"
          >
            Revoke
          </button>
        </>
      )}
    </div>
  );
}

export function DevicesClient({ publicRelayUrl }: DevicesClientProps) {
  const router = useRouter();
  const { session, logout } = useAuth();
  const [nodes, setNodes] = useState<RelayNode[]>([]);
  const [devices, setDevices] = useState<RelayDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // The device awaiting confirmation. Revocation ends that device's sessions
  // and envelopes, so it must be an explicit second action, not one click.
  const [revokeTarget, setRevokeTarget] = useState<RelayDevice | null>(null);
  const [revoking, setRevoking] = useState(false);
  // Manual ping results keyed by peer id. A poll re-render must not clear them,
  // so they live here rather than in the row components.
  const [pings, setPings] = useState<Record<string, PingState>>({});
  // In-flight rename dialog target. `current` lets us treat a no-op as cancel.
  const [renamePeer, setRenamePeer] = useState<{ kind: "node" | "device"; id: string; current: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const openRename = useCallback((kind: "node" | "device", id: string, current: string) => {
    setRenameError(null);
    setRenameValue(current);
    setRenamePeer({ kind, id, current });
  }, []);

  // Persist a display name and patch the local catalog so the label updates
  // without waiting for the next 30s poll.
  const confirmRenamePeer = useCallback(async () => {
    if (!renamePeer) return;
    const trimmed = renameValue.trim();
    if (trimmed === renamePeer.current.trim()) {
      setRenamePeer(null);
      return;
    }
    setRenaming(true);
    setRenameError(null);
    try {
      const stored =
        renamePeer.kind === "node"
          ? await renameNode(renamePeer.id, trimmed)
          : await renameDevice(renamePeer.id, trimmed);
      if (renamePeer.kind === "node") {
        setNodes((previous) =>
          previous.map((n) => (n.node_id === renamePeer.id ? { ...n, display_name: stored } : n)),
        );
      } else {
        setDevices((previous) =>
          previous.map((d) => (d.device_id === renamePeer.id ? { ...d, display_name: stored } : d)),
        );
      }
      setRenamePeer(null);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenaming(false);
    }
  }, [renamePeer, renameValue]);

  // Send a manual probe and record the outcome. The Relay performs the round
  // trip; this only reflects its verdict.
  const runPing = useCallback(async (peerId: string, kind: "node" | "device") => {
    setPings((previous) => ({ ...previous, [peerId]: { status: "pending" } }));
    try {
      const result = kind === "node" ? await pingNode(peerId) : await pingDevice(peerId);
      setPings((previous) => ({ ...previous, [peerId]: { status: "done", result } }));
    } catch (err) {
      setPings((previous) => ({
        ...previous,
        [peerId]: { status: "error", message: err instanceof Error ? err.message : String(err) },
      }));
    }
  }, []);

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

  // The catalog is fetched once on mount, but a node that stops heartbeating
  // should flip to offline on its own. Re-poll on the sidebar's cadence so the
  // page body and the collapsed-sidebar count stay in agreement without a
  // manual reload; this effect only sets state from async callbacks, keeping
  // the loading spinner tied to the initial mount fetch. The Relay throttles
  // last_seen_at DB writes to once a minute, so a quit node can still read as
  // online for up to ~3.5 minutes before it falls out of the heartbeat window.
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(() => {
      void Promise.all([listNodes(), listDevices()])
        .then(([n, d]) => {
          if (cancelled) return;
          setNodes(n);
          setDevices(d);
        })
        .catch(() => {
          // transient network blip; the next tick retries
        });
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Runs only after the user confirms in ConfirmDialog. Revocation deletes the
  // device's key envelopes and kills its sessions, so it is gated behind an
  // explicit confirmation instead of firing on a single click.
  const confirmRevoke = useCallback(async () => {
    if (!revokeTarget) return;
    const id = revokeTarget.device_id;
    setRevoking(true);
    try {
      await revokeDevice(id);
      // Revoking the device this browser is signed in on ends its own session:
      // return to the auth wizard rather than leaving the user on a dead page.
      if (id === session?.device_id) {
        await logout();
        router.push("/auth");
        return;
      }
      // Re-sync the list so the just-revoked device flips to its revoked state.
      setDevices(await listDevices());
      setError(null);
      setRevokeTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevoking(false);
    }
  }, [revokeTarget, session, logout, router]);

  // Re-sync the node catalog so a freshly paired node appears without a reload.
  const refreshNodes = useCallback(async () => {
    try {
      setNodes(await listNodes());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6">
      <PageHeader
        eyebrow="Network"
        title="Devices"
        description="Storage nodes and client devices registered to this account, with live reachability."
      />

      {error && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
          {error}
        </p>
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
            // Also block while the catalog loads: the dialog snapshots the
            // current node ids as its pairing baseline, so opening with an
            // empty/stale catalog would misread an existing node as "new".
            disabled={publicRelayUrl === null || loading}
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
            icon="server"
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
          <div className="border border-border rounded-2xl overflow-hidden bg-card elev-card stagger">
            {nodes.map((n) => (
              <NodeRowView
                key={n.node_id}
                node={n}
                onManage={() => router.push("/pair")}
                onPing={() => void runPing(n.node_id, "node")}
                onRename={() => openRename("node", n.node_id, n.display_name ?? "")}
                pingState={pings[n.node_id]}
              />
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
            icon="phone"
          />
        ) : (
          <div className="border border-border rounded-2xl overflow-hidden bg-card elev-card stagger">
            {devices.map((d) => (
              <DeviceRowView
                key={d.device_id}
                device={d}
                onRevoke={() => setRevokeTarget(d)}
                onPing={() => void runPing(d.device_id, "device")}
                onRename={() => openRename("device", d.device_id, d.display_name ?? "")}
                pingState={pings[d.device_id]}
              />
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

      {renamePeer && (
        <Modal
          className="w-[420px] max-w-full"
          onClose={renaming ? () => undefined : () => setRenamePeer(null)}
        >
          <ModalHeader
            title={renamePeer.kind === "node" ? "Name storage node" : "Name device"}
            onClose={renaming ? () => undefined : () => setRenamePeer(null)}
          />
          <div className="p-5 space-y-4">
            <Input
              label="Name"
              value={renameValue}
              autoFocus
              maxLength={64}
              hint="Leave empty to fall back to the short id."
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void confirmRenamePeer()}
            />
            {renameError && (
              <p className="text-xs text-destructive" role="alert">
                {renameError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRenamePeer(null)} disabled={renaming}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={() => void confirmRenamePeer()} disabled={renaming}>
                {renaming ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
