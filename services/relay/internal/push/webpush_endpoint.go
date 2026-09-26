package push

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// A web push endpoint is chosen by the browser and handed to the relay, which
// then fetches it from the server side. That makes it a client-supplied URL the
// relay connects to on the client's behalf, and the reachable set is whatever
// the relay can see: the cloud metadata service, a database or admin port on the
// host, a neighbouring container. Nothing stops the caller from registering
// `https://169.254.169.254/latest/meta-data/` and then provoking an event to
// make the relay call it, so the endpoint is validated both when it is
// registered and, more importantly, at the moment the relay dials it.

// extraBlockedPrefixes are the ranges netip does not classify on its own.
// 0.0.0.0/8 is "this host" on Linux, so http://0.0.0.1/ reaches loopback the same
// way 127.0.0.1 does; 100.64.0.0/10 is the CGNAT range that is not "private" by
// RFC 1918 but is exactly the sort of internal range that must not be fetched.
var extraBlockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
}

// blockedIP reports whether ip is an address the relay must never connect to on
// behalf of a client-supplied URL. The default is "must be a public address":
// the safe reading of an unrecognised range is that it is internal.
func blockedIP(ip netip.Addr) (bool, string) {
	// An IPv4-mapped IPv6 address is the IPv4 address wearing a hat; without
	// this, ::ffff:127.0.0.1 would slip past the IPv4 checks.
	ip = ip.Unmap()
	switch {
	case !ip.IsValid():
		return true, "not a valid address"
	case ip.IsLoopback():
		return true, "loopback"
	case ip.IsPrivate():
		return true, "private network"
	case ip.IsLinkLocalUnicast():
		return true, "link-local (this includes the 169.254.169.254 metadata service)"
	case ip.IsLinkLocalMulticast():
		return true, "link-local multicast"
	case ip.IsUnspecified():
		return true, "unspecified address"
	case ip.IsMulticast():
		return true, "multicast"
	}
	for _, p := range extraBlockedPrefixes {
		if p.Contains(ip) {
			return true, p.String()
		}
	}
	return false, ""
}

// ValidateWebPushEndpoint reports whether raw is an endpoint the relay is willing
// to store and deliver to.
//
// This is a filter for early feedback, not the enforcement. A hostname can
// resolve to a public address now and a private one later, and a URL written as
// an integer ("https://2130706433/") is not an IP literal to any parser here but
// resolves to 127.0.0.1 in the dialer. The delivery path therefore re-checks the
// resolved address at connect time — see newWebPushClient — and this check only
// has to agree with it often enough to give the caller an immediate, specific
// error instead of a push that silently never arrives.
func ValidateWebPushEndpoint(raw string) error {
	if strings.TrimSpace(raw) == "" {
		return fmt.Errorf("endpoint is empty")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("endpoint is not a valid URL")
	}
	// Browsers only ever hand out https endpoints, so anything else is either a
	// client bug or a probe for a plaintext listener.
	if u.Scheme != "https" {
		return fmt.Errorf("endpoint must be https, not %q", u.Scheme)
	}
	// Credentials in a URL make it read as one host and be fetched from another,
	// and no push service has any use for them.
	if u.User != nil {
		return fmt.Errorf("endpoint must not contain credentials")
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("endpoint has no host")
	}
	// localhost is defined by RFC 6761 to always mean loopback, so it can be
	// rejected without a lookup. Everything else is left to the dialer.
	if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return fmt.Errorf("endpoint host %q is a loopback name", host)
	}
	// An IP literal is the destination itself, so it can be judged now. A
	// hostname is resolved at dial time instead, where the answer is a fact
	// rather than a claim.
	if ip, err := netip.ParseAddr(host); err == nil {
		if blocked, why := blockedIP(ip); blocked {
			return fmt.Errorf("endpoint address %s is not a public address (%s)", host, why)
		}
	}
	return nil
}

// newWebPushClient returns the client used to deliver web push notifications.
//
// The check is on the resolved address at connect time, not on the hostname in
// the URL. The hostname is a claim; the address the socket reaches is the fact,
// and validating the claim is what a DNS-rebinding attack is written against —
// resolve now, resolve differently at connect, and the guard that inspected the
// first answer never sees the second. Resolving here and dialling the address
// just validated means there is no second answer to consult, so the window is
// closed rather than narrowed.
//
// This also covers redirects for free: the transport dials every hop, so a
// public host answering 302 with a link-local Location is refused at the socket
// instead of being followed.
func newWebPushClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				host, port, err := net.SplitHostPort(addr)
				if err != nil {
					return nil, fmt.Errorf("webpush: malformed address %q: %w", addr, err)
				}
				addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
				if err != nil {
					return nil, fmt.Errorf("webpush: resolve %q: %w", host, err)
				}
				var dialer net.Dialer
				var blockedErr, dialErr error
				for _, ip := range addrs {
					if blocked, why := blockedIP(ip); blocked {
						// A name may legitimately resolve to several addresses, so
						// skip the internal ones and try what is left. Only fail if
						// nothing routable remains.
						if blockedErr == nil {
							blockedErr = fmt.Errorf("webpush: %s resolves to %s, which is not a public address (%s)", host, ip, why)
						}
						continue
					}
					conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
					if err == nil {
						return conn, nil
					}
					if dialErr == nil {
						dialErr = err
					}
				}
				if blockedErr != nil {
					return nil, blockedErr
				}
				if dialErr != nil {
					return nil, dialErr
				}
				return nil, fmt.Errorf("webpush: %s resolved to no addresses", host)
			},
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: timeout,
			MaxIdleConns:          4,
		},
		// A push service does not redirect, and following one would turn a
		// delivery into a different request than the one that was validated.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}
