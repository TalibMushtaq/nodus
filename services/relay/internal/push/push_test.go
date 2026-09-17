package push

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestExpoSenderPostsBatchWithAuth(t *testing.T) {
	var gotAuth string
	var gotBody []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("authorization")
		require.NoError(t, json.NewDecoder(r.Body).Decode(&gotBody))
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	sender := NewExpoSender("secret")
	sender.endpoint = srv.URL

	require.NoError(t, sender.Send(context.Background(), []Message{
		{To: "ExponentPushToken[a]", Title: "Hi", Body: "There", Data: map[string]string{"type": "conflicts"}},
	}))

	require.Equal(t, "Bearer secret", gotAuth)
	require.Len(t, gotBody, 1)
	require.Equal(t, "ExponentPushToken[a]", gotBody[0]["to"])
	require.Equal(t, "default", gotBody[0]["sound"])
}

func TestExpoSenderSplitsAtBatchLimit(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	sender := NewExpoSender("")
	sender.endpoint = srv.URL

	messages := make([]Message, 150)
	for i := range messages {
		messages[i] = Message{To: "ExponentPushToken[x]"}
	}
	require.NoError(t, sender.Send(context.Background(), messages))
	require.Equal(t, 2, calls, "150 messages should split into batches of 100 + 50")
}

func TestExpoSenderErrorsOnNonSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	sender := NewExpoSender("")
	sender.endpoint = srv.URL
	require.Error(t, sender.Send(context.Background(), []Message{{To: "t"}}))
}

func TestExpoSenderNoMessagesIsNoop(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("no request should be made for an empty batch")
	}))
	defer srv.Close()
	sender := NewExpoSender("")
	sender.endpoint = srv.URL
	require.NoError(t, sender.Send(context.Background(), nil))
}
