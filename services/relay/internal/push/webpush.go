package push

import (
	"context"
	"encoding/json"
	"log"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// WebSubscription is a browser PushSubscription registered for an account.
type WebSubscription struct {
	Endpoint string
	P256dh   string
	Auth     string
}

// WebSender delivers notifications to browser push subscriptions.
type WebSender interface {
	SendWeb(ctx context.Context, subs []WebSubscription, title, body string, data map[string]string) error
}

// webPushDeliveryTimeout caps one subscription's delivery. It is per attempt, so
// a batch of subscriptions cannot spend the caller's whole context on the first
// one that hangs.
const webPushDeliveryTimeout = 10 * time.Second

// VapidWebSender signs Web Push requests with the operator's VAPID key pair.
type VapidWebSender struct {
	publicKey  string
	privateKey string
	subject    string
}

func NewVapidWebSender(publicKey, privateKey, subject string) *VapidWebSender {
	return &VapidWebSender{publicKey: publicKey, privateKey: privateKey, subject: subject}
}

// SendWeb delivers the payload to each subscription independently; one expired
// endpoint must not stop the others. The first error is returned for logging.
func (s *VapidWebSender) SendWeb(
	ctx context.Context,
	subs []WebSubscription,
	title, body string,
	data map[string]string,
) error {
	if len(subs) == 0 {
		return nil
	}
	payload, err := json.Marshal(map[string]any{"title": title, "body": body, "data": data})
	if err != nil {
		return err
	}

	var firstErr error
	for _, sub := range subs {
		res, err := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{
			Endpoint: sub.Endpoint,
			Keys:     webpush.Keys{Auth: sub.Auth, P256dh: sub.P256dh},
		}, &webpush.Options{
			Subscriber:      s.subject,
			VAPIDPublicKey:  s.publicKey,
			VAPIDPrivateKey: s.privateKey,
			TTL:             60,
			// The endpoint came from a browser, so the relay is about to connect
			// to a client-chosen address. The client is what makes the dial safe,
			// not just the URL: it re-checks the resolved address on every
			// connection, which also covers the endpoints already in the table
			// from before this check existed.
			HTTPClient: newWebPushClient(webPushDeliveryTimeout),
		})
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			log.Printf("[push] web send failed: %v", err)
			continue
		}
		if res != nil {
			_ = res.Body.Close()
			if res.StatusCode >= 300 {
				// 404/410 mean the subscription is gone; the client re-registers
				// on its next visit, so we simply log it.
				log.Printf("[push] web send: HTTP %d", res.StatusCode)
			}
		}
	}
	return firstErr
}
