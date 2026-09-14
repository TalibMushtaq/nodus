"use client";

// Storage Node pairing & LAN discovery for the web app.
//
// Phase 7a §4: pairing is session-authenticated. The account session lives in
// the HttpOnly nodus_session cookie (managed by Next route handlers + Relay);
// this page calls proxied handlers (/api/nodes, /api/pairing/*) and never
// constructs a Bearer header or touches sessionStorage. The device's Ed25519
// keypair lives only in this browser (localStorage), never leaves it, and is
// used to bind + sign tokens.
//
// Web clients skip active mDNS (design decision D): this screen walks the
// Relay Path B flow (token issued by the Relay, node already knows it via the
// WS push) and offers manual-IP probing of `/nodus/discovery` for the
// offline/fast-path pairing.
//
// NOTE (mixed content): the browser blocks http://<LAN node>:9378 requests
// from an https:// page. Dev flows run over http://localhost:3000; production
// TLS behind is out of v1 scope (see docs/security/local-endpoints.md).

import {
  NodeClient,
  NodeClientError,
  fetchAdvertisement,
  nodusBaseUrl,
} from "@repo/relay-client/local-discovery";
import {
  identityPrivateKey,
  identityPublicKey,
  type StoredDeviceIdentity,
} from "@repo/relay-client/device-identity";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Section } from "@repo/ui/primitives/section";
import { PageHeader } from "@repo/ui/primitives/page-header";
import { Button } from "@repo/ui/primitives/button";
import { StatusBadge } from "@repo/ui/primitives/badge";
import { addTrustedNode, getTrustedNodes, type TrustedNode } from "../../lib/trusted-nodes";
import {
  listNodes,
  issuePairingToken,
  type PairingSession,
  type RelayNode,
} from "../../lib/pairing";
import { getOrCreateDeviceIdentity } from "../../lib/device";
import { useAuth } from "../../providers/auth-provider";

export default function PairPage() {
  const router = useRouter();
  const { status, session, logout } = useAuth();

  // Device identity is browser-only (localStorage). The lazy initializer returns
  // null during the server pass and resolves on the client, following the same
  // post-SSR bootstrap as the auth provider.
  const [device] = useState<StoredDeviceIdentity | null>(() =>
    typeof window === "undefined" ? null : getOrCreateDeviceIdentity(),
  );

  // ── session status + node catalog ───────────────────────────────
  const [nodes, setNodes] = useState<RelayNode[]>([]);
  const [nodeError, setNodeError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    listNodes()
      .then((n) => {
        if (!cancelled) setNodes(n);
      })
      .catch((err) => {
        if (!cancelled) setNodeError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [status]);

  const handleLogout = useCallback(async () => {
    await logout();
    router.push("/auth");
  }, [logout, router]);

  const refreshNodes = useCallback(async () => {
    setNodeError(null);
    try {
      setNodes(await listNodes());
    } catch (err) {
      setNodeError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // ── token issuance (RELAY_PATH_B) ───────────────────────────────
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [pending, setPending] = useState<PairingSession | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);

  const issueToken = useCallback(async () => {
    if (!device || !selectedNode) return;
    setPairError(null);
    try {
      const sess = await issuePairingToken(selectedNode, device);
      setPending(sess);
    } catch (err) {
      if (err instanceof Error && err.message.includes("401")) {
        router.push("/auth");
        return;
      }
      setPairError(err instanceof Error ? err.message : String(err));
    }
  }, [device, selectedNode, router]);

  const pairingUrl = useMemo(() => {
    if (!pending || !device) return null;
    // Decision C: QR deep link carries node_id (hex) + pubkey (base64) + token.
    return `nodus://pair?node_id=${encodeURIComponent(pending.node_id)}&pubkey=${encodeURIComponent(device.public_key)}&token=${encodeURIComponent(pending.token)}`;
  }, [device, pending]);

  // ── LAN discovery (manual-IP fallback) + direct pair/auth ───────
  const [lanHost, setLanHost] = useState("");
  const [probe, setProbe] = useState<{ host: string; ok: boolean; detail?: string } | null>(null);
  const [lanResult, setLanResult] = useState<string | null>(null);
  const [trusted, setTrusted] = useState<TrustedNode[]>([]);

  useEffect(() => {
    void getTrustedNodes().then(setTrusted);
  }, [lanResult]);

  const probeNode = useCallback(async () => {
    setProbe(null);
    setLanResult(null);
    const base = nodusBaseUrl(lanHost);
    try {
      const adv = await fetchAdvertisement(base);
      setProbe({ host: lanHost, ok: true, detail: `${adv.node_id.slice(0, 12)}… (v${adv.schema_version})` });
    } catch (err) {
      setProbe({
        host: lanHost,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, [lanHost]);

  const pairOnDevice = useCallback(async () => {
    if (!device || !pending || !probe?.ok) return;
    setLanResult(null);
    const client = new NodeClient(nodusBaseUrl(probe.host));
    try {
      const confirm = await client.pair(
        pending.token,
        pending.node_id,
        device.device_id,
        identityPublicKey(device),
      );
      await addTrustedNode({
        node_id: (confirm.node_id as string) ?? pending.node_id,
        host: probe.host,
        account_id: (confirm.account_id as string) ?? "local_push",
        device_id: device.device_id,
        paired_at: new Date().toISOString(),
      });
      setLanResult("paired — this browser device is now trusted by the node");
    } catch (err) {
      setLanResult(
        err instanceof NodeClientError ? `pair failed: ${err.message}` : String(err),
      );
    }
  }, [device, pending, probe]);

  const authenticateOnDevice = useCallback(async () => {
    if (!device || !probe?.ok) return;
    setLanResult(null);
    try {
      const client = new NodeClient(nodusBaseUrl(probe.host));
      await client.authenticate(device.device_id, identityPrivateKey(device));
      setLanResult("authenticated — the node accepted this device's signature");
    } catch (err) {
      setLanResult(
        err instanceof NodeClientError ? `auth failed: ${err.message}` : String(err),
      );
    }
  }, [device, probe]);

  const inputCls =
    "flex-1 min-w-[180px] px-3 py-2 text-sm bg-secondary border border-border rounded-xl text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20";

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-6">
      <PageHeader
        eyebrow="Setup"
        title="Pair a Storage Node"
        description="Bind this browser to a node so your files can sync directly over the LAN."
        actions={
          <Link href="/overview" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            ← Back to dashboard
          </Link>
        }
      />

      {/* Device id is server-side unknown (window-gated init); suppress the
          transient hydration mismatch on the prerendered HTML. */}
      <p className="text-xs text-muted-foreground" suppressHydrationWarning>
        Node identity: device id{" "}
        <code className="font-mono text-foreground">{device?.device_id ?? "…"}</code>
      </p>

      <Section title="1 · Relay session">
        {status === "loading" ? (
          <p className="text-xs text-muted-foreground">Checking session…</p>
        ) : status === "authenticated" && session ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">
              Signed in as{" "}
              <code className="font-mono text-foreground">{session.account_id.slice(0, 12)}…</code>{" "}
              (device <code className="font-mono text-foreground">{session.device_id.slice(0, 12)}…</code>)
            </span>
            <Button variant="secondary" size="sm" onClick={() => void handleLogout()}>
              Sign out
            </Button>
          </div>
        ) : (
          <Link href="/auth" className="text-xs text-accent hover:opacity-80">
            Sign in to pair a storage node
          </Link>
        )}
      </Section>

      <Section title="2 · Choose your node">
        <div className="mb-2">
          <Button variant="secondary" size="sm" onClick={() => void refreshNodes()} disabled={status !== "authenticated"}>
            Refresh nodes
          </Button>
        </div>
        {nodeError && <p className="text-xs text-destructive mb-2">{nodeError}</p>}
        {nodes.length === 0 && !nodeError ? (
          <p className="text-xs text-muted-foreground">No storage nodes registered yet.</p>
        ) : (
          <ul className="stagger rounded-2xl border border-border overflow-hidden bg-card divide-y divide-border elev-card">
            {nodes.map((n) => (
              <li key={n.node_id}>
                <label className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-secondary/40">
                  <input
                    type="radio"
                    name="node"
                    checked={selectedNode === n.node_id}
                    onChange={() => setSelectedNode(n.node_id)}
                  />
                  <code className="font-mono text-xs text-foreground">{n.node_id.slice(0, 12)}…</code>
                  {n.is_primary && (
                    <span className="px-1.5 py-0.5 text-[9px] font-medium border border-accent/40 text-accent bg-accent/10 rounded">
                      PRIMARY
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground ml-auto">{n.status}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <Button
            variant="primary"
            size="sm"
            onClick={() => void issueToken()}
            disabled={status !== "authenticated" || !selectedNode}
          >
            Issue pairing token
          </Button>
        </div>
        {pending && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              Token issued — scan with a mobile app, or finish pairing this browser below.
            </p>
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-secondary border border-border p-3 rounded-xl text-foreground">
              {pairingUrl}
            </pre>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => pairingUrl && void navigator.clipboard?.writeText(pairingUrl)}
            >
              Copy deep link
            </Button>
          </div>
        )}
        {pairError && <p className="text-xs text-destructive mt-2">{pairError}</p>}
      </Section>

      <Section title="3 · Finish locally (manual IP fallback)">
        <div className="flex flex-wrap gap-2 mb-2">
          <input
            value={lanHost}
            onChange={(e) => setLanHost(e.target.value)}
            placeholder="storage node IP, e.g. 192.168.1.10"
            className={inputCls}
            aria-label="Storage node IP address"
          />
          <Button variant="secondary" size="sm" onClick={() => void probeNode()}>
            Probe node
          </Button>
        </div>
        {probe && (
          <p
            className="text-xs"
            style={{ color: probe.ok ? "var(--status-synced)" : "var(--status-conflict)" }}
          >
            {probe.host}: {probe.detail}
          </p>
        )}
        <div className="flex flex-wrap gap-2 mt-3">
          <Button variant="primary" size="sm" onClick={() => void pairOnDevice()} disabled={!pending || !probe?.ok}>
            Pair this browser
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void authenticateOnDevice()} disabled={!probe?.ok}>
            Authenticate (re-auth)
          </Button>
        </div>
        {lanResult && (
          <p
            className="text-xs mt-2"
            role="status"
            style={{ color: lanResult.startsWith("paired") ? "var(--status-synced)" : "var(--status-conflict)" }}
          >
            {lanResult}
          </p>
        )}
      </Section>

      <Section title="Trusted nodes (this browser)">
        {trusted.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing paired yet.</p>
        ) : (
          <ul className="stagger rounded-2xl border border-border overflow-hidden bg-card divide-y divide-border elev-card">
            {trusted.map((t) => (
              <li key={t.node_id} className="px-4 py-3 text-xs text-muted-foreground">
                <code className="font-mono text-foreground">{t.node_id.slice(0, 12)}…</code> @ {t.host} — paired{" "}
                {t.paired_at}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="flex items-center gap-2">
        <StatusBadge status="local-only" variant="inline" />
        <span className="text-[10px] text-muted-foreground">
          Device keypair is stored only in this browser and never sent to the Relay.
        </span>
      </div>
    </main>
  );
}
