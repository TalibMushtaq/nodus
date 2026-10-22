// Pure Relay URL rules, kept separate from persistence so they can be unit
// tested without pulling in expo-secure-store.
//
// The Relay origin is entered at runtime instead of being baked in at build
// time. Its session is a bearer credential, so a remote origin must use TLS:
// plain HTTP would expose that credential to any on-path observer. Cleartext is
// therefore allowed only for loopback and the Android emulator alias.

/** Hosts where cleartext is allowed: loopback plus the Android emulator alias. */
export function isLocalRelayHost(host: string): boolean {
  // URL.hostname keeps IPv6 brackets ("[::1]"), while the URL may also have
  // been typed bare, so normalize both forms before comparing.
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "10.0.2.2"
  );
}

/** Strip a trailing slash (and a lone root slash) from a base URL path. */
function canonicalBase(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * Validate an already-schemed Relay URL and return it in canonical form.
 *
 * Canonical form keeps the scheme, host (including port) and optional path but
 * drops credentials, query strings, fragments and trailing slashes: the client
 * appends fixed Relay paths such as `/health` and `/auth/login` to this base.
 */
export function validateRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid server URL, for example https://relay.example.com.");
  }

  if (url.username || url.password) {
    throw new Error("Server URL must not include a username or password.");
  }

  url.search = "";
  url.hash = "";

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("Server URL must start with http:// or https://.");
  }
  if (!url.hostname) {
    throw new Error("Server URL is missing a host.");
  }
  if (protocol === "http:" && !isLocalRelayHost(url.hostname)) {
    throw new Error(
      "Use https:// for a remote Relay. Plain HTTP is allowed only for localhost and the Android emulator alias 10.0.2.2.",
    );
  }

  return canonicalBase(url);
}

/**
 * Turn user input into a canonical Relay base URL.
 *
 * A missing scheme is inferred so typing `relay.example.com` works: HTTPS for
 * remote hosts, HTTP for local development hosts. WebSocket schemes are mapped
 * to their HTTP counterparts because the HTTP base is what most calls need and
 * the WS client derives `ws(s)://` from it.
 */
export function normalizeRelayUrl(input: string): string {
  let candidate = input.trim();
  if (!candidate) throw new Error("Enter the Relay server URL.");

  // No scheme: infer one from the host before URL parsing.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    let hostname = "";
    try {
      hostname = new URL(`http://${candidate}`).hostname;
    } catch {
      throw new Error("Enter a valid server URL, for example https://relay.example.com.");
    }
    const scheme = isLocalRelayHost(hostname) ? "http" : "https";
    candidate = `${scheme}://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Enter a valid server URL, for example https://relay.example.com.");
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol === "ws:") url.protocol = "http:";
  else if (protocol === "wss:") url.protocol = "https:";

  return validateRelayUrl(url.toString());
}
