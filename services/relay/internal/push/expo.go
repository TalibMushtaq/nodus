package push

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// expoEndpoint is Expo's push send API. A variable (not a const) so tests can
// point it at a local server.
const expoEndpoint = "https://exp.host/--/api/v2/push/send"

// expoBatchLimit is Expo's documented maximum recipients per request.
const expoBatchLimit = 100

// ExpoSender posts messages to Expo's push API.
type ExpoSender struct {
	endpoint    string
	client      *http.Client
	accessToken string
}

// NewExpoSender builds a sender. `accessToken` is optional; when empty the
// requests are unauthenticated, which Expo permits at low volume.
func NewExpoSender(accessToken string) *ExpoSender {
	return &ExpoSender{
		endpoint:    expoEndpoint,
		client:      &http.Client{Timeout: 10 * time.Second},
		accessToken: accessToken,
	}
}

type expoMessage struct {
	To    string            `json:"to"`
	Title string            `json:"title,omitempty"`
	Body  string            `json:"body,omitempty"`
	Data  map[string]string `json:"data,omitempty"`
	Sound string            `json:"sound,omitempty"`
}

// Send posts the messages in batches of at most 100, stopping at the first
// failed batch so a caller can retry the remainder.
func (s *ExpoSender) Send(ctx context.Context, messages []Message) error {
	if len(messages) == 0 {
		return nil
	}
	for start := 0; start < len(messages); start += expoBatchLimit {
		end := start + expoBatchLimit
		if end > len(messages) {
			end = len(messages)
		}
		if err := s.sendBatch(ctx, messages[start:end]); err != nil {
			return err
		}
	}
	return nil
}

func (s *ExpoSender) sendBatch(ctx context.Context, batch []Message) error {
	payload := make([]expoMessage, 0, len(batch))
	for _, m := range batch {
		payload = append(payload, expoMessage{
			To:    m.To,
			Title: m.Title,
			Body:  m.Body,
			Data:  m.Data,
			Sound: "default",
		})
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json")
	if s.accessToken != "" {
		req.Header.Set("authorization", "Bearer "+s.accessToken)
	}

	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	// Drain a little of the body so the connection can be reused.
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
	if res.StatusCode >= 300 {
		return fmt.Errorf("expo push: HTTP %d", res.StatusCode)
	}
	return nil
}
