package push

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/stretchr/testify/require"
)

// vapidTestSender builds a sender with a real key pair: the delivery path signs
// the request before it dials, so a fake key would fail before reaching the
// network and prove nothing about the guard.
func vapidTestSender(t *testing.T) *VapidWebSender {
	t.Helper()
	priv, pub, err := webpush.GenerateVAPIDKeys()
	require.NoError(t, err)
	return NewVapidWebSender(pub, priv, "mailto:ops@example.com")
}

// validSubKeys returns subscription keys a push service would accept, so a
// delivery attempt fails at the network rather than at encryption.
func validSubKeys(t *testing.T) (string, string) {
	t.Helper()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	require.NoError(t, err)
	auth := make([]byte, 16)
	_, err = rand.Read(auth)
	require.NoError(t, err)
	return base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes()),
		base64.RawURLEncoding.EncodeToString(auth)
}

// serveOn starts an HTTP server on an exact address and reports what it received.
func serveOn(t *testing.T, address string) (url string, received chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", address)
	if err != nil {
		t.Skipf("cannot bind %s: %v", address, err)
	}
	received = make(chan string, 8)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case received <- r.Method + " " + r.URL.Path:
		default:
		}
		w.WriteHeader(http.StatusOK)
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	host, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split %s: %v", ln.Addr(), err)
	}
	return "http://" + net.JoinHostPort(host, port), received
}

func hits(ch chan string) []string {
	var out []string
	for {
		select {
		case h := <-ch:
			out = append(out, h)
		default:
			return out
		}
	}
}

// TestWebPushDeliveryRefusesInternalEndpoint is the regression test for the
// SSRF: before the guard, a subscription whose endpoint pointed at a loopback
// listener received the relay's POST and SendWeb reported success.
func TestWebPushDeliveryRefusesInternalEndpoint(t *testing.T) {
	p256dh, auth := validSubKeys(t)
	sender := vapidTestSender(t)

	// Same address, three spellings. The last one is a hostname, which proves
	// the enforcement is on the resolved address and not on the URL text.
	for name, address := range map[string]string{
		"ipv4 loopback": "127.0.0.1:0",
		"all zeroes":    "0.0.0.0:0",
		"localhost":     "localhost:0",
	} {
		t.Run(name, func(t *testing.T) {
			url, received := serveOn(t, address)
			// The endpoint is https because that is what a browser produces; the
			// server is plain HTTP because the test only cares that nothing is
			// dialled, not what happens after a connection.
			host := strings.TrimPrefix(url, "http://")
			err := sender.SendWeb(context.Background(), []WebSubscription{{
				Endpoint: "https://" + host + "/push",
				P256dh:   p256dh,
				Auth:     auth,
			}}, "title", "body", nil)

			require.Error(t, err, "delivery to %s must fail", address)
			require.Contains(t, err.Error(), "not a public address")
			require.Empty(t, hits(received), "the internal listener received a push")
		})
	}
}

// TestWebPushDeliveryRefusesRedirectToInternal covers the hop a URL check cannot
// see. Because the guard is in the dialer rather than in a URL matcher, every
// hop is covered by construction; this pins that property.
func TestWebPushDeliveryRefusesRedirectToInternal(t *testing.T) {
	p256dh, auth := validSubKeys(t)
	sender := vapidTestSender(t)

	internalURL, internalHits := serveOn(t, "127.0.0.1:0")

	edge := httptestTLSServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, internalURL+"/latest/meta-data/", http.StatusFound)
	})

	err := sender.SendWeb(context.Background(), []WebSubscription{{
		Endpoint: edge + "/redirect",
		P256dh:   p256dh,
		Auth:     auth,
	}}, "title", "body", nil)
	t.Logf("redirect attempt returned: %v", err)

	require.Empty(t, hits(internalHits),
		"a redirect must not be able to turn a validated push into a request to an internal address")
}

// TestWebPushClientRefusesHostThatResolvesInternal covers the dialer directly. A
// hostname passes the registration check by design — it is judged where it
// resolves — so this asserts the judgement actually happens, including for the
// spellings no IP parser in the URL path recognises: the system resolver reads
// "2130706433" and "0x7f000001" as 127.0.0.1, and a validator looking only at
// the URL text sees an ordinary hostname.
func TestWebPushClientRefusesHostThatResolvesInternal(t *testing.T) {
	for _, host := range []string{"localhost", "2130706433", "0x7f000001"} {
		t.Run(host, func(t *testing.T) {
			_, received := serveOn(t, "127.0.0.1:0")

			req, err := http.NewRequestWithContext(context.Background(), "POST",
				"https://"+host+":9/push", strings.NewReader("{}"))
			require.NoError(t, err)

			client := newWebPushClient(500 * time.Millisecond)
			_, err = client.Do(req)
			require.Error(t, err, "a request to %s must not succeed", host)
			// The resolver either understands the spelling, in which case the
			// guard names the address it meant, or it does not resolve it at all.
			// Both stop the request; only the first can explain itself.
			if !strings.Contains(err.Error(), "no such host") {
				require.Contains(t, err.Error(), "not a public address")
			}
			require.Empty(t, hits(received))
		})
	}
}

func TestValidateWebPushEndpoint(t *testing.T) {
	rejected := map[string]string{
		"empty":                "",
		"whitespace":           "   ",
		"malformed":            "://nope",
		"relative":             "/push/endpoint",
		"plaintext http":       "http://fcm.googleapis.com/fcm/send/abc",
		"file scheme":          "file:///etc/passwd",
		"credentials in url":   "https://user:pass@fcm.googleapis.com/send",
		"no host":              "https:///send",
		"loopback name":        "https://localhost/send",
		"loopback subdomain":   "https://push.localhost/send",
		"uppercase localhost":  "https://LOCALHOST/send",
		"mixed case localhost": "https://push.LocalHost/send",
		"ipv4 loopback":        "https://127.0.0.1/send",
		"ipv4 loopback alt":    "https://127.1.2.3/send",
		"ipv6 loopback":        "https://[::1]/send",
		"ipv4 mapped loopback": "https://[::ffff:127.0.0.1]/send",
		"this host":            "https://0.0.0.0/send",
		"this host alt":        "https://0.0.0.1/send",
		"private 10":           "https://10.0.0.5/send",
		"private 172":          "https://172.16.0.1/send",
		"private 192":          "https://192.168.1.1/send",
		"metadata service":     "https://169.254.169.254/latest/meta-data/",
		"cgnat":                "https://100.64.0.1/send",
		"ipv6 unique local":    "https://[fd00::1]/send",
		"ipv6 link local":      "https://[fe80::1]/send",
		"unspecified ipv6":     "https://[::]/send",
		"multicast":            "https://224.0.0.1/send",
	}
	for name, endpoint := range rejected {
		t.Run("rejects "+name, func(t *testing.T) {
			require.Error(t, ValidateWebPushEndpoint(endpoint),
				"%q must not be accepted as a push endpoint", endpoint)
		})
	}

	accepted := []string{
		"https://fcm.googleapis.com/fcm/send/abc123",
		"https://updates.push.services.mozilla.com/wpush/v2/xyz",
		"https://push.example.com/send/abc?x=1",
		"https://8.8.8.8/send",
		"https://[2606:4700:4700::1111]/send",
		// Names are not resolved here on purpose. A name is a claim, and the
		// dialer is where claims get checked.
		"https://metadata.google.internal/send",
	}
	for _, endpoint := range accepted {
		t.Run("accepts "+endpoint, func(t *testing.T) {
			require.NoError(t, ValidateWebPushEndpoint(endpoint))
		})
	}
}

// TestBlockedIPTable spells the ranges out rather than trusting the
// classification, because a range that is silently unblocked is a silently open
// SSRF and this list is the whole policy.
func TestBlockedIPTable(t *testing.T) {
	cases := []struct {
		ip    string
		why   string
		block bool
	}{
		{"8.8.8.8", "", false},
		{"1.1.1.1", "", false},
		{"93.184.216.34", "", false},
		{"127.0.0.1", "loopback", true},
		{"127.255.255.254", "loopback", true},
		{"0.0.0.0", "unspecified", true},
		{"0.0.0.7", "0.0.0.0/8", true},
		{"10.1.2.3", "private", true},
		{"172.16.0.1", "private", true},
		{"172.31.255.254", "private", true},
		{"192.168.0.1", "private", true},
		{"169.254.169.254", "link-local", true},
		{"169.254.0.1", "link-local", true},
		{"100.64.0.1", "100.64.0.0/10", true},
		{"100.127.255.254", "100.64.0.0/10", true},
		{"::1", "loopback", true},
		{"::", "unspecified", true},
		{"fd00::1", "private", true},
		{"fe80::1", "link-local", true},
		{"224.0.0.1", "multicast", true},
		{"ff02::1", "multicast", true},
		{"2606:4700:4700::1111", "", false},
	}
	for _, c := range cases {
		blocked, why := blockedIP(mustAddr(t, c.ip))
		require.Equal(t, c.block, blocked, "%s: blocked=%v, want %v", c.ip, blocked, c.block)
		if c.block {
			require.NotEmpty(t, why, "%s was blocked without a reason", c.ip)
			require.Contains(t, why, c.why, "%s blocked for the wrong reason", c.ip)
		}
	}

	// The boundaries just outside each range must stay reachable, or the filter
	// has swallowed public space.
	for _, ip := range []string{"172.32.0.1", "100.128.0.1", "172.15.255.255", "100.63.255.255"} {
		blocked, _ := blockedIP(mustAddr(t, ip))
		require.False(t, blocked, "%s is outside every blocked range", ip)
	}
}

func TestSendWebIgnoresEmptySubscriptionList(t *testing.T) {
	require.NoError(t, vapidTestSender(t).SendWeb(context.Background(), nil, "t", "b", nil))
}

func mustAddr(t *testing.T, s string) netip.Addr {
	t.Helper()
	ip, err := netip.ParseAddr(s)
	require.NoError(t, err)
	return ip
}

// httptestTLSServer stands in for a public push service. Its certificate is
// self-signed and therefore not trusted, which is fine: no assertion here
// depends on a completed handshake, only on which address the guard refuses to
// dial.
func httptestTLSServer(t *testing.T, h http.HandlerFunc) string {
	t.Helper()
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	return srv.URL
}
