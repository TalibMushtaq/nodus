package auth_test

import (
	"testing"

	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
)

func TestHashAndVerifyPassword(t *testing.T) {
	password := "superSecretPassword123!"

	hashed, err := auth.HashPassword(password)
	if err != nil {
		t.Fatalf("failed to hash password: %v", err)
	}

	if hashed == "" || hashed == password {
		t.Fatalf("hashed password should not be empty or plaintext")
	}

	// Verify with correct password
	valid, err := auth.VerifyPassword(hashed, password)
	if err != nil {
		t.Fatalf("unexpected error verifying password: %v", err)
	}
	if !valid {
		t.Fatalf("expected password to be valid")
	}

	// Verify with wrong password
	valid, err = auth.VerifyPassword(hashed, "wrongPassword")
	if err != nil {
		t.Fatalf("unexpected error on wrong password: %v", err)
	}
	if valid {
		t.Fatalf("expected wrong password to fail verification")
	}
}

func TestVerifyInvalidHashFormat(t *testing.T) {
	_, err := auth.VerifyPassword("not-a-valid-argon2-hash", "password")
	if err == nil {
		t.Fatalf("expected error on invalid hash format")
	}
}
