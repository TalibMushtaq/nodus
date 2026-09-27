// Manual LAN host validation and advertisement binding.
//
// A user-entered host feeds `nodusBaseUrl`, which string-concatenates it into
// `http://${host}:9378`. Left unchecked, a value like `127.0.0.1@attacker.example`
// or `evil.example/path` changes the parsed authority instead of naming one
// host. `normalizeLanHost` accepts only a bare IPv4/IPv6/hostname (optionally
// pasted with a scheme or the fixed port) and returns the normalized host.

const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
// Bracketed IPv6 literal, e.g. [fe80::1] or [::1].
const IPV6_RE = /^\[[0-9a-f:.]+\]$/i;
// Bare IPv4 (each octet 0-255).
const IPV4_RE =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Normalize a manually-entered node host: tolerate a pasted `http(s)://`
 * prefix and a trailing `:port`/path, strip both, and validate what remains is
 * a bare IPv4, bracketed IPv6, or hostname. Returns the lowercase host, or null
 * when the input is not a plausible single host (credentials, extra path,
 * spaces, or a malformed label).
 */
export function normalizeLanHost(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  value = value.replace(/^https?:\/\//i, "");
  // Reject userinfo outright: `host@other` would redirect to `other`.
  if (value.includes("@")) return null;
  // Drop any path/query/fragment; a node is addressed by host only.
  value = value.replace(/[/?#].*$/, "");
  // Drop a trailing numeric port; the protocol fixes the port, so any provided
  // one is ignored rather than trusted.
  value = value.replace(/:\d+$/, "");
  // Drop brackets for validation, remember IPv6-ness via the bracket form.
  const isIpv6 = IPV6_RE.test(value);
  const bare = isIpv6 ? value.slice(1, -1) : value;
  if (!bare) return null;
  if (!isIpv6 && !IPV4_RE.test(bare) && !HOSTNAME_RE.test(bare)) return null;
  if (isIpv6 && !/^[0-9a-f:.]+$/i.test(bare)) return null;
  return value.toLowerCase();
}

/**
 * Whether a discovery advertisement genuinely belongs to `expectedNodeId`.
 *
 * A Storage Node's `node_id` *is* the hex of its Ed25519 public key (see the
 * Rust `identity::load_or_generate`), so a well-formed advertisement must have
 * `public_key === node_id`. Checking that invariant plus the expected id means a
 * host cannot advertise a `node_id` unrelated to the key it presents. It is not
 * a full authentication — the public key is public and a real signature would
 * be needed to defeat an active MITM — but it rejects malformed/naive spoofs
 * and keeps the client from trusting an advertisement that contradicts itself.
 */
export function advertisementBindsNode(
  adv: { node_id: string; public_key: string },
  expectedNodeId?: string | null,
): boolean {
  const publicKey = adv.public_key.toLowerCase();
  const nodeId = adv.node_id.toLowerCase();
  if (nodeId !== publicKey) return false;
  if (expectedNodeId && nodeId !== expectedNodeId.toLowerCase()) return false;
  return true;
}
