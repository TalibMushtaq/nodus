"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, ModalHeader } from "@repo/ui/primitives/overlay";
import { Button } from "@repo/ui/primitives/button";
import { Input } from "@repo/ui/primitives/input";
import { StatusBadge } from "@repo/ui/primitives/badge";
import { Icon } from "@repo/ui/primitives/icons";

import { createPairingCode, findNewNode, listNodes, type RelayNode } from "../lib/pairing";
import { formatCountdown, shortId } from "../lib/format";

// "+ Add Storage Node" dialog: mints a one-time pairing code for the signed-in
// account and hands the user the exact CLI command for the Storage Node. The
// browser only *issues* the code (the node redeems it over HTTPS via
// `nodus node pair`), so success is detected by polling GET /nodes for a node
// that was not present when the dialog opened; redeem-time errors
// (code_expired/node_owned_elsewhere) are surfaced by the CLI, not here.

const TICK_MS = 1000;
const POLL_MS = 3000;

type Phase = "creating" | "waiting" | "paired" | "expired" | "error";

interface AddStorageNodeDialogProps {
  /** Operator-configured PUBLIC_RELAY_URL (non-null; the caller guards). */
  relayUrl: string;
  /** Node ids present when the dialog opened — the pairing baseline. */
  existingNodeIds: string[];
  onClose: () => void;
  onPaired?: (node: RelayNode) => void;
}

function secondsUntil(expiryMs: number): number {
  return Math.max(0, Math.ceil((expiryMs - Date.now()) / 1000));
}

export function AddStorageNodeDialog({
  relayUrl,
  existingNodeIds,
  onClose,
  onPaired,
}: AddStorageNodeDialogProps) {
  const [generation, setGeneration] = useState(0);
  const [phase, setPhase] = useState<Phase>("creating");
  const [code, setCode] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [node, setNode] = useState<RelayNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Captured once at mount: the dialog is remounted per open, and the baseline
  // must stay fixed at "nodes that existed before this pairing attempt".
  const baselineRef = useRef(existingNodeIds);
  const onPairedRef = useRef(onPaired);
  useEffect(() => {
    onPairedRef.current = onPaired;
  }, [onPaired]);

  useEffect(() => {
    let cancelled = false;
    let tick: ReturnType<typeof setInterval> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (tick !== undefined) clearInterval(tick);
      if (poll !== undefined) clearInterval(poll);
      tick = undefined;
      poll = undefined;
    };

    createPairingCode()
      .then((created) => {
        if (cancelled) return;
        const expiry = new Date(created.expires_at).getTime();
        setCode(created.code);
        setPhase("waiting");
        setSecondsLeft(secondsUntil(expiry));

        tick = setInterval(() => {
          const left = secondsUntil(expiry);
          setSecondsLeft(left);
          if (left <= 0) {
            stop();
            setPhase("expired");
          }
        }, TICK_MS);

        poll = setInterval(() => {
          void listNodes()
            .then((nodes) => {
              if (cancelled) return;
              const found = findNewNode(baselineRef.current, nodes);
              if (found) {
                stop();
                setNode(found);
                setPhase("paired");
                onPairedRef.current?.(found);
              }
            })
            .catch((e: unknown) => {
              if (cancelled) return;
              stop();
              setError(e instanceof Error ? e.message : String(e));
              setPhase("error");
            });
        }, POLL_MS);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      });

    return () => {
      cancelled = true;
      stop();
    };
  }, [generation]);

  const regenerate = useCallback(() => {
    setCode(null);
    setNode(null);
    setError(null);
    setSecondsLeft(0);
    setCopied(false);
    setPhase("creating");
    setGeneration((g) => g + 1);
  }, []);

  const command = code ? `nodus node pair --relay ${relayUrl} --code ${code}` : "";

  const copyCommand = useCallback(async () => {
    if (!command) return;
    await navigator.clipboard?.writeText(command);
    setCopied(true);
  }, [command]);

  return (
    <Modal className="w-[460px]" onClose={onClose}>
      <ModalHeader title="Add storage node" onClose={onClose} />
      <div className="p-5 space-y-4">
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground">Relay URL</p>
          <p
            className="text-xs font-mono text-muted-foreground break-all"
            data-testid="pairing-relay-url"
          >
            {relayUrl}
          </p>
        </div>

        {code ? (
          <div className="space-y-3">
            <Input
              label="Pairing code"
              readOnly
              value={code}
              data-testid="pairing-code"
              className="font-mono"
            />
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">Run on the Storage Node</p>
              <div className="flex items-center gap-2">
                <code
                  data-testid="pairing-command"
                  className="flex-1 px-3 py-2 text-[11px] font-mono bg-secondary border border-border text-foreground break-all"
                >
                  {command}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void copyCommand()}
                  data-testid="pairing-copy"
                  aria-label="Copy CLI command"
                >
                  <Icon name={copied ? "check" : "copy"} size={14} />
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground" data-testid="pairing-countdown">
                {phase === "expired"
                  ? "Pairing code expired"
                  : `Expires in ${formatCountdown(secondsLeft)}`}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Creating pairing code…</p>
        )}

        <div className="flex items-center gap-2" data-testid="pairing-status">
          {phase === "creating" && <StatusBadge status="pending" variant="inline" />}
          {phase === "waiting" && (
            <>
              <StatusBadge status="pending" variant="inline" />
              <span className="text-xs text-muted-foreground">Waiting for the node to pair…</span>
            </>
          )}
          {phase === "paired" && node && (
            <>
              <StatusBadge status={node.last_seen_at ? "synced" : "offline"} variant="inline" />
              <span className="text-xs text-muted-foreground">
                Node paired — <span className="font-mono">{shortId(node.node_id)}</span>
              </span>
            </>
          )}
          {phase === "expired" && (
            <>
              <Icon name="warning" size={14} className="text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                Pairing code expired. Generate a new code to retry.
              </span>
            </>
          )}
          {phase === "error" && (
            <>
              <Icon name="warning" size={14} className="text-destructive" />
              <span className="text-xs text-destructive">{error}</span>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          {(phase === "expired" || phase === "error") && (
            <Button
              variant="secondary"
              size="sm"
              onClick={regenerate}
              data-testid="pairing-regenerate"
            >
              Generate new code
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            data-testid="pairing-close"
          >
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
