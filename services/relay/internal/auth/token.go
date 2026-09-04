package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	ErrInvalidToken = errors.New("invalid or expired token")
	ErrTokenRevoked = errors.New("refresh token has been revoked")
)

// Claims represents JWT token claims.
type Claims struct {
	AccountID string `json:"sub"`
	jwt.RegisteredClaims
}

// IssueAccessToken creates a short-lived signed JWT access token.
func IssueAccessToken(cfg *config.Config, accountID string) (string, time.Time, error) {
	now := time.Now().UTC()
	expiresAt := now.Add(cfg.JWTExpiry)

	claims := &Claims{
		AccountID: accountID,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   accountID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			ID:        uuid.NewString(),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString([]byte(cfg.JWTSecret))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("signing jwt: %w", err)
	}

	return signed, expiresAt, nil
}

// ParseAccessToken validates and parses a signed JWT.
func ParseAccessToken(cfg *config.Config, tokenStr string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return []byte(cfg.JWTSecret), nil
	})

	if err != nil {
		return nil, ErrInvalidToken
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, ErrInvalidToken
	}

	return claims, nil
}

// IssueRefreshToken creates an opaque refresh token and stores its SHA-256 hash in PostgreSQL.
func IssueRefreshToken(ctx context.Context, pool *db.Pool, cfg *config.Config, accountID string, deviceID *string) (string, error) {
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", err
	}

	rawToken := base64.RawURLEncoding.EncodeToString(tokenBytes)
	tokenHash := HashToken(rawToken)

	tokenID := uuid.NewString()
	expiresAt := time.Now().UTC().Add(cfg.RefreshExpiry)

	query := `
		INSERT INTO refresh_tokens (token_id, account_id, token_hash, device_id, expires_at)
		VALUES ($1, $2, $3, $4, $5)
	`

	_, err := pool.Exec(ctx, query, tokenID, accountID, tokenHash, deviceID, expiresAt)
	if err != nil {
		return "", fmt.Errorf("inserting refresh token: %w", err)
	}

	return rawToken, nil
}

// RotateRefreshToken validates an old refresh token, revokes it, and issues a new access + refresh token pair.
func RotateRefreshToken(ctx context.Context, pool *db.Pool, cfg *config.Config, rawOldToken string) (newAccessToken, newRefreshToken string, expiresAt time.Time, err error) {
	tokenHash := HashToken(rawOldToken)

	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", "", time.Time{}, err
	}
	defer tx.Rollback(ctx) // nolint:errcheck

	var (
		tokenID   string
		accountID string
		deviceID  *string
		dbExpires time.Time
		revokedAt *time.Time
	)

	query := `
		SELECT token_id, account_id, device_id, expires_at, revoked_at
		FROM refresh_tokens
		WHERE token_hash = $1
		FOR UPDATE
	`

	err = tx.QueryRow(ctx, query, tokenHash).Scan(&tokenID, &accountID, &deviceID, &dbExpires, &revokedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", time.Time{}, ErrInvalidToken
		}
		return "", "", time.Time{}, err
	}

	if revokedAt != nil {
		return "", "", time.Time{}, ErrTokenRevoked
	}

	if time.Now().UTC().After(dbExpires) {
		return "", "", time.Time{}, ErrInvalidToken
	}

	// Revoke old token
	now := time.Now().UTC()
	_, err = tx.Exec(ctx, "UPDATE refresh_tokens SET revoked_at = $1 WHERE token_id = $2", now, tokenID)
	if err != nil {
		return "", "", time.Time{}, err
	}

	// Generate new access token
	newAccessToken, expiresAt, err = IssueAccessToken(cfg, accountID)
	if err != nil {
		return "", "", time.Time{}, err
	}

	// Generate new refresh token
	newBytes := make([]byte, 32)
	if _, err := rand.Read(newBytes); err != nil {
		return "", "", time.Time{}, err
	}
	newRefreshToken = base64.RawURLEncoding.EncodeToString(newBytes)
	newTokenHash := HashToken(newRefreshToken)

	newTokenID := uuid.NewString()
	newExpiresAt := now.Add(cfg.RefreshExpiry)

	_, err = tx.Exec(ctx, `
		INSERT INTO refresh_tokens (token_id, account_id, token_hash, device_id, expires_at)
		VALUES ($1, $2, $3, $4, $5)
	`, newTokenID, accountID, newTokenHash, deviceID, newExpiresAt)
	if err != nil {
		return "", "", time.Time{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return "", "", time.Time{}, err
	}

	return newAccessToken, newRefreshToken, expiresAt, nil
}

// RevokeRefreshToken revokes a single refresh token by its raw value.
func RevokeRefreshToken(ctx context.Context, pool *db.Pool, rawToken string) error {
	tokenHash := HashToken(rawToken)
	now := time.Now().UTC()
	_, err := pool.Exec(ctx, "UPDATE refresh_tokens SET revoked_at = $1 WHERE token_hash = $2", now, tokenHash)
	return err
}

// HashToken computes SHA-256 hex string of a raw token.
func HashToken(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}
