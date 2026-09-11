"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { StatCard } from "@repo/ui/primitives/stat-card";
import { Section } from "@repo/ui/primitives/section";
import { EmptyState } from "@repo/ui/primitives/empty-state";

import { listNodes, listDevices, type RelayNode, type RelayDevice } from "../../../lib/pairing";
import { useWs } from "../../../providers/ws-provider";

// Home snapshot. The only figures with a real backend are the Relay's device
// and storage-node catalogs plus the live WebSocket state; the old file-used /
// pending / conflict cards and quick-access folders were mock-only and are gone.

export default function OverviewPage() {
  const router = useRouter();
  const { status: wsStatus } = useWs();
  const [nodes, setNodes] = useState<RelayNode[]>([]);
  const [devices, setDevices] = useState<RelayDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const relayOnline = wsStatus === "connected" || wsStatus === "reconnecting";

  return (
    <div className="space-y-6 p-6">
      {error && <p className="text-xs text-destructive">{error}</p>}

      {!loading && nodes.length === 0 && devices.length === 0 ? (
        <Section title="Overview">
          <EmptyState
            title="Nothing connected yet"
            description="Pair a Storage Node to start syncing files across your network."
          />
        </Section>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <StatCard
            label="Storage nodes"
            value={loading ? "…" : String(nodes.length)}
            sub={nodes.some((n) => n.is_primary) ? "Primary configured" : "No primary"}
            link="View nodes \u2192"
            color="var(--color-accent)"
            onClick={() => router.push("/devices")}
          />
          <StatCard
            label="Client devices"
            value={loading ? "…" : String(devices.length)}
            sub={devices.some((d) => d.status === "REVOKED") ? "One or more revoked" : "All active"}
            link="View devices \u2192"
            color="var(--status-synced)"
            onClick={() => router.push("/devices")}
          />
          <StatCard
            label="Relay"
            value={relayOnline ? "Connected" : "Offline"}
            sub={wsStatus}
            link="Pair a node \u2192"
            color="var(--status-pending)"
            onClick={() => router.push("/pair")}
          />
        </div>
      )}
    </div>
  );
}