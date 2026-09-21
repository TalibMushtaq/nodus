import { useEffect, useRef, useState } from "react";
import { listNodes, isNodeOnline, type RelayNode } from "./pairing";
import { notifyLocal } from "./local-notifications";

export interface NodeStatus {
  /** Total paired nodes for this account. */
  total: number;
  /** Nodes whose last heartbeat is within the online window. */
  online: number;
  /** True while the first fetch has not completed. */
  loading: boolean;
}

/** Suppress repeat offline alerts for a flapping node within this window. */
const OFFLINE_ALERT_COOLDOWN_MS = 10 * 60_000;

/**
 * Polls `GET /api/nodes` and derives an aggregate online/offline count.
 * The sidebar renders this as a single status line ("Node · Online (1/1)").
 *
 * It also emits a local browser notification when a node transitions from
 * online to offline. The sidebar mounts on every dashboard page, so this is the
 * one place the whole app sees the transition; the first poll only seeds the
 * baseline, and a per-node cooldown keeps a flapping node from spamming.
 */
export function useNodeStatus(pollMs = 30_000): NodeStatus {
  const [status, setStatus] = useState<NodeStatus>({ total: 0, online: 0, loading: true });
  // Previous online state per node; null until the first poll seeds it.
  const previousOnlineRef = useRef<Map<string, boolean> | null>(null);
  // Last alert time per node, to bound repeat notifications.
  const lastAlertRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const nodes: RelayNode[] = await listNodes();
        if (cancelled) return;
        const now = Date.now();
        const currentOnline = new Map(nodes.map((node) => [node.node_id, isNodeOnline(node, now)]));

        // Alert only on an online→offline edge, so a node that was already down
        // when the tab opened does not notify on load.
        const previousOnline = previousOnlineRef.current;
        if (previousOnline) {
          for (const [nodeId, online] of currentOnline) {
            if (online || previousOnline.get(nodeId) !== true) continue;
            const lastAlert = lastAlertRef.current.get(nodeId) ?? 0;
            if (now - lastAlert < OFFLINE_ALERT_COOLDOWN_MS) continue;
            lastAlertRef.current.set(nodeId, now);
            void notifyLocal("device_offline", {
              title: "Storage node offline",
              body: "A storage node stopped responding.",
            });
            // One alert per poll even if several nodes drop together.
            break;
          }
        }
        previousOnlineRef.current = currentOnline;

        const online = [...currentOnline.values()].filter(Boolean).length;
        setStatus({ total: nodes.length, online, loading: false });
      } catch {
        // Network blip: keep the last-known count; mark loading done.
        if (!cancelled) setStatus((prev) => ({ ...prev, loading: false }));
      }
    }

    poll();
    const timer = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  return status;
}
