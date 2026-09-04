package auth_test

import (
	"testing"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
)

func TestJWTIssueAndParse(t *testing.T) {
	cfg := &config.Config{
		JWTSecret: "test-secret-key-1234567890",
		JWTExpiry: 15 * time.Minute,
	}

	accountID := "acc-12345-uuid"

	tokenStr, expiresAt, err := auth.IssueAccessToken(cfg, accountID)
	if err != nil {
		t.Fatalf("failed to issue jwt: %v", err)
	}

	if time.Now().UTC().After(expiresAt) {
		t.Fatalf("expiresAt should be in the future")
	}

	claims, err := auth.ParseAccessToken(cfg, tokenStr)
	if err != nil {
		t.Fatalf("failed to parse jwt: %v", err)
	}

	if claims.AccountID != accountID {
		t.Fatalf("expected accountID %s, got %s", accountID, claims.AccountID)
	}
}

func TestJWTExpired(t *testing.T) {
	cfg := &config.Config{
		JWTSecret: "test-secret-key-1234567890",
		JWTExpiry: -1 * time.Minute, // already expired
	}

	tokenStr, _, err := auth.IssueAccessToken(cfg, "acc-expired")
	if err != nil {
		t.Fatalf("failed to issue jwt: %v", err)
	}

	_, err = auth.ParseAccessToken(cfg, tokenStr)
	if err == nil {
		t.Fatalf("expected error parsing expired jwt")
	}
}

func TestJWTInvalidSecret(t *testing.T) {
	cfg1 := &config.Config{
		JWTSecret: "secret-key-one-1234567890",
		JWTExpiry: 15 * time.Minute,
	}
	cfg2 := &config.Config{
		JWTSecret: "secret-key-two-0987654321",
		JWTExpiry: 15 * time.Minute,
	}

	tokenStr, _, err := auth.IssueAccessToken(cfg1, "acc-test")
	if err != nil {
		t.Fatalf("failed to issue jwt: %v", err)
	}

	_, err = auth.ParseAccessToken(cfg2, tokenStr)
	if err == nil {
		t.Fatalf("expected error when validating jwt with mismatched secret")
	}
}
