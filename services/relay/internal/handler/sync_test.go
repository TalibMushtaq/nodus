package handler_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/handler"
	"github.com/TalibMushtaq/nodus/services/relay/internal/hub"
)

func TestNodeAuthSignatureVerification(t *testing.T) {
	// Generate an ed25519 keypair
	pubKey, privKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}

	pubKeyHex := hex.EncodeToString(pubKey)
	_ = pubKeyHex

	nonce := "test-nonce-1234567890abcdef1234567890abcdef"
	nonceBytes := []byte(nonce)

	// Sign exact nonce bytes
	sig := ed25519.Sign(privKey, nonceBytes)
	sigHex := hex.EncodeToString(sig)

	// Verify exact bytes
	decodedPub, err := hex.DecodeString(pubKeyHex)
	if err != nil {
		t.Fatalf("failed to decode pubkey: %v", err)
	}
	decodedSig, err := hex.DecodeString(sigHex)
	if err != nil {
		t.Fatalf("failed to decode signature: %v", err)
	}

	if !ed25519.Verify(decodedPub, nonceBytes, decodedSig) {
		t.Fatalf("signature verification failed")
	}

	// Verify invalid nonce fails
	if ed25519.Verify(decodedPub, []byte("different-nonce"), decodedSig) {
		t.Fatalf("expected signature verification to fail on mismatched nonce")
	}
}

func TestIssueAuthChallenge(t *testing.T) {
	ctx := context.Background()
	h := hub.New(nil)
	go h.Run(ctx)

	client := &hub.Client{
		Hub:    h,
		ConnID: "conn-auth-1",
		Send:   make(chan []byte, 10),
	}

	handler.IssueAuthChallenge(ctx, client, nil)

	select {
	case msg := <-client.Send:
		var env handler.ProtocolEnvelope
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatalf("invalid json: %v", err)
		}
		if env.Type != "node_auth_challenge" {
			t.Fatalf("expected type node_auth_challenge, got %s", env.Type)
		}

		var payload handler.NodeAuthChallengePayload
		if err := json.Unmarshal(env.Payload, &payload); err != nil {
			t.Fatalf("invalid payload: %v", err)
		}
		if len(payload.Nonce) == 0 {
			t.Fatalf("expected non-empty nonce")
		}
		if client.AuthNonce != payload.Nonce {
			t.Fatalf("expected client.AuthNonce to match payload.Nonce")
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatalf("timed out waiting for challenge")
	}
}
