// Manual LAN host validation and advertisement binding.
//
// A user-entered host feeds `nodusBaseUrl`, which string-concatenates it into
// `http://${host}:9378`. Left unchecked, a value like `127.0.0.1@attacker.example`
// or `evil.example/path` changes the parsed authority instead of naming one
// host. `normalizeLanHost` accepts only a bare IPv4/IPv6/hostname (optionally
// pasted with a scheme or the fixed port) and returns the normalized host.

const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
// Bare IPv4 (each octet 0-255).
const IPV4_RE =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Validate a bare IPv6 literal with the platform parser.
 *
 * The previous character-class regex accepted malformed values such as `a` or
 * `::::`, and this host later feeds `nodusBaseUrl` for signed requests, so a
 * bad value would send device authentication to the wrong authority. A URL
 * round-trip only succeeds for a real IPv6 address.
 */
function isValidIpv6(bare: string): boolean {
  try {
    const hostname = new URL(`http://[${bare}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]");
  } catch {
    return false;
  }
}

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
  // Drop brackets for validation, remembering IPv6-ness via the bracket form.
  const isIpv6 = value.startsWith("[") && value.endsWith("]");
  const bare = isIpv6 ? value.slice(1, -1) : value;
  if (!bare) return null;
  if (isIpv6) {
    if (!isValidIpv6(bare)) return null;
  } else if (!IPV4_RE.test(bare) && !HOSTNAME_RE.test(bare)) {
    return null;
  }
  return value.toLowerCase();
}

/**
 * Whether a discovery advertisement genuinely belongs to `expectedNodeId`.
 *
 * Re-exported from `@repo/relay-client` so web and mobile enforce the same
 * `public_key === node_id` binding before any key material is exchanged.
 */
export { advertisementBindsNode } from "@repo/relay-client";
