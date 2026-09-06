"use client";

// Storage Node pairing & LAN discovery for the web app.
//
// Web clients skip active mDNS (design decision D): this screen walks the
// Relay Path B flow (token issued by the Relay, node already knows it via the
// WS push) and offers manual-IP probing of `/nodus/discovery` for the
// offline/fast-path pairing. The device's Ed25519 keypair lives only in this
// browser (localStorage), never leaves it, and is used to bind + sign tokens.
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

import { addTrustedNode, getTrustedNodes, type TrustedNode } from "../../lib/trusted-nodes";

const RELAY_BASE =
  process.env.NEXT_PUBLIC_RELAY_URL ?? "http://localhost:8080";
const IDENTITY_KEY = "nodus.device.identity";

interface RelayNode {
  node_id: string;
  account_id: string;
  public_key: string;
  capabilities: string[];
  status: string;
  is_primary: boolean;
  created_at: string;
}

interface StoredSession {
  token: string;
  expires_at: string;
  node_id?: string;
  device_id?: string;
}

export default function PairPage() {
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

  // ── relay auth + catalog ────────────────────────────────────────
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [jwt, setJwt] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<RelayNode[]>([]);

  const login = useCallback(async () => {
    setAuthError(null);
    const res = await fetch(`${RELAY_BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      setAuthError(await res.text());
      return;
    }
    const body = (await res.json()) as { access_token: string };
    sessionStorage.setItem("nodus.jwt", body.access_token);
    setJwt(body.access_token);
  }, [email, password]);

  const loadNodes = useCallback(async () => {
    if (!jwt) return;
    const res = await fetch(`${RELAY_BASE}/nodes`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) {
      setAuthError(await res.text());
      return;
    }
    setNodes((await res.json()) as RelayNode[]);
  }, [jwt]);

  const jsonHeaders = useCallback((token: string | null): Record<string, string> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  }, []);

  // ── token issuance (RELAY_PATH_B) ───────────────────────────────
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [pending, setPending] = useState<StoredSession | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);

  const issueToken = useCallback(async () => {
    if (!device || !jwt || !selectedNode) return;
    setPairError(null);
    // Ensure the device is registered to the account (idempotent upsert),
    // otherwise CreatePairingSession rejects the device lookup.
    const regRes = await fetch(`${RELAY_BASE}/devices/register`, {
      method: "POST",
      headers: jsonHeaders(jwt),
      body: JSON.stringify({
        device_id: device.device_id,
        public_key: device.public_key,
      }),
    });
    if (!regRes.ok) {
      setPairError(`device registration failed: ${await regRes.text()}`);
      return;
    }
    const res = await fetch(`${RELAY_BASE}/pairing/sessions`, {
      method: "POST",
      headers: jsonHeaders(jwt),
      body: JSON.stringify({ node_id: selectedNode, device_id: device.device_id }),
    });
    if (!res.ok) {
      setPairError(`token issuance failed: ${await res.text()}`);
      return;
    }
    setPending((await res.json()) as StoredSession);
  }, [device, jsonHeaders, jwt, selectedNode]);

  const pairingUrl = useMemo(() => {
    if (!pending || !device) return null;
    // Decision C: QR deep link carries node_id (hex) + pubkey (base64) + token.
    return `nodus://pair?node_id=${encodeURIComponent(pending.node_id ?? selectedNode ?? "")}&pubkey=${encodeURIComponent(device.public_key)}&token=${encodeURIComponent(pending.token)}`;
  }, [device, pending, selectedNode]);

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
        pending.node_id ?? selectedNode ?? "",
        device.device_id,
        identityPublicKey(device),
      );
      await addTrustedNode({
        node_id: (confirm.node_id as string) ?? pending.node_id ?? "",
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
  }, [device, pending, probe, selectedNode]);

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
        <h2>1 · Relay sign-in</h2>
        <div className="row">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password"
          />
          <button onClick={() => void login()} disabled={!device}>
            Sign in
          </button>
        </div>
        <p className="error">{authError}</p>
      </section>

      <section>
        <h2>2 · Choose your node</h2>
        <div className="row">
          <button onClick={() => void loadNodes()} disabled={!jwt}>
            Load my nodes
          </button>
        </div>
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
          <button onClick={() => void issueToken()} disabled={!jwt || !selectedNode}>
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