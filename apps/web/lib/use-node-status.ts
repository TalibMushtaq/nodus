import { useEffect, useState } from "react";
import { listNodes, isNodeOnline, type RelayNode } from "./pairing";

export interface NodeStatus {
  /** Total paired nodes for this account. */
  total: number;
  /** Nodes whose last heartbeat is within the online window. */
  online: number;
  /** True while the first fetch has not completed. */
  loading: boolean;
}

/**
 * Polls `GET /api/nodes` and derives an aggregate online/offline count.
 * The sidebar renders this as a single status line ("Node · Online (1/1)").
 */
export function useNodeStatus(pollMs = 30_000): NodeStatus {
  const [status, setStatus] = useState<NodeStatus>({ total: 0, online: 0, loading: true });

  useEffect(() => {
let cancelled = false;

    async function poll() {
      try {
        const nodes: RelayNode[] = await listNodes();
        if (cancelled) return;
        const now = Date.now();
        const online = nodes.filter((n) => isNodeOnline(n, now)).length;
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
