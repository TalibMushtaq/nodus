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
  createDeviceIdentity,
  identityPrivateKey,
  identityPublicKey,
  type StoredDeviceIdentity,
} from "@repo/relay-client/device-identity";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { addTrustedNode, getTrustedNodes, type TrustedNode } from "../../lib/trusted-nodes";
import {
  listNodes,
  issuePairingToken,
  type PairingSession,
  type RelayNode,
} from "../../lib/pairing";
import { useAuth } from "../../providers/auth-provider";

const IDENTITY_KEY = "nodus.device.identity";

export default function PairPage() {
  const router = useRouter();
  const { status, session, logout } = useAuth();

  // ── device identity (persisted). Lazy initializer avoids setState-in-effect
  // (react-hooks v6 rule) and keeps this a pure render-time concern. On the
  // server pass (SSR/SSG prerender) window is undefined so this stays null;
  // the browser pass generates + persists the keypair on first visit.
  const [device] = useState<StoredDeviceIdentity | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (raw) {
      try {
        return JSON.parse(raw) as StoredDeviceIdentity;
      } catch {
        // Corrupt stored identity — regenerate below.
      }
    }
    const fresh = createDeviceIdentity();
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(fresh));
    return fresh;
  });

  // ── session status + node catalog ───────────────────────────────
  const [nodes, setNodes] = useState<RelayNode[]>([]);
  const [nodeError, setNodeError] = useState<string | null>(null);

  // Auto-load the node catalog once the session resolves (§4). The server-side
  // /pair layout already gated on requireAuth(), but the client status starts
  // "loading" until the session handler round-trips.
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

  return (
    <main className="pair">
      <h1>Pair a Storage Node</h1>
      {/* device id is server-side unknown (window-gated init); suppress the
          transient hydration mismatch on the prerendered HTML */}
      <p className="hint" suppressHydrationWarning>
        Node identity: device id&nbsp;<code>{device?.device_id ?? "…"}</code>
      </p>

      <section>
        <h2>1 · Relay session</h2>
        {status === "loading" ? (
          <p className="hint">Checking session…</p>
        ) : status === "authenticated" && session ? (
          <div className="row">
            <span>
              Signed in as <code>{session.account_id.slice(0, 12)}…</code> (device <code>{session.device_id.slice(0, 12)}…</code>)
            </span>
            <button onClick={() => void handleLogout()}>Sign out</button>
          </div>
        ) : (
          <a href="/auth">Sign in to pair a storage node</a>
        )}
      </section>

      <section>
        <h2>2 · Choose your node</h2>
        <div className="row">
          <button onClick={() => void refreshNodes()} disabled={status !== "authenticated"}>
            Refresh nodes
          </button>
        </div>
        {nodeError && <p className="error">{nodeError}</p>}
        <ul>
          {nodes.map((n) => (
            <li key={n.node_id}>
              <label>
                <input
                  type="radio"
                  name="node"
                  checked={selectedNode === n.node_id}
                  onChange={() => setSelectedNode(n.node_id)}
                />
                <code>{n.node_id.slice(0, 12)}…</code>
                {n.is_primary ? " (primary)" : ""} — {n.status}
              </label>
            </li>
          ))}
        </ul>
        <div className="row">
          <button onClick={() => void issueToken()} disabled={status !== "authenticated" || !selectedNode}>
            Issue pairing token
          </button>
        </div>
        {pending && (
          <div className="token">
            <p>
              Token issued — scan with a mobile app, or finish pairing this
              browser below.
            </p>
            <pre className="link">{pairingUrl}</pre>
            <button
              onClick={() => pairingUrl && void navigator.clipboard?.writeText(pairingUrl)}
            >
              Copy deep link
            </button>
          </div>
        )}
        <p className="error">{pairError}</p>
      </section>

      <section>
        <h2>3 · Finish locally (manual IP fallback)</h2>
        <div className="row">
          <input
            value={lanHost}
            onChange={(e) => setLanHost(e.target.value)}
            placeholder="storage node IP, e.g. 192.168.1.10"
          />
          <button onClick={() => void probeNode()}>Probe node</button>
        </div>
        {probe && (
          <p className={probe.ok ? "ok" : "error"}>
            {probe.host}: {probe.detail}
          </p>
        )}
        <div className="row">
          <button onClick={() => void pairOnDevice()} disabled={!pending || !probe?.ok}>
            Pair this browser
          </button>
          <button onClick={() => void authenticateOnDevice()} disabled={!probe?.ok}>
            Authenticate (re-auth)
          </button>
        </div>
        <p className={lanResult?.startsWith("paired") ? "ok" : "error"}>{lanResult}</p>
      </section>

      <section>
        <h2>Trusted nodes (this browser)</h2>
        {trusted.length === 0 && <p className="hint">Nothing paired yet.</p>}
        <ul>
          {trusted.map((t) => (
            <li key={t.node_id}>
              <code>{t.node_id.slice(0, 12)}…</code> @ {t.host} — paired {t.paired_at}
            </li>
          ))}
        </ul>
      </section>

      <style jsx>{`
        .pair {
          max-width: 720px;
          margin: 2rem auto;
          font-family: var(--font-geist-mono), monospace;
        }
        section {
          border-top: 1px solid #e5e5e5;
          padding: 1rem 0;
        }
        .row {
          display: flex;
          gap: 0.5rem;
          flex-wrap: wrap;
          align-items: center;
        }
        input {
          flex: 1;
          min-width: 180px;
          padding: 0.4rem;
        }
        .link {
          white-space: pre-wrap;
          word-break: break-all;
          background: #f5f5f5;
          padding: 0.5rem;
        }
        .hint {
          color: #666;
        }
        .error {
          color: #c0392b;
        }
        .ok {
          color: #27ae60;
        }
      `}</style>
    </main>
  );
}

