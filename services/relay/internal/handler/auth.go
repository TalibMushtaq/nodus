package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/TalibMushtaq/nodus/services/relay/internal/auth"
	"github.com/TalibMushtaq/nodus/services/relay/internal/config"
	"github.com/TalibMushtaq/nodus/services/relay/internal/db"
)

type RegisterRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type AuthResponse struct {
	AccountID    string    `json:"account_id"`
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresAt    time.Time `json:"expires_at"`
	ExpiresIn    int64     `json:"expires_in"` // in seconds
}

type RefreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type LogoutRequest struct {
	RefreshToken string `json:"refresh_token"`
}

// Register creates a new user account.
func Register(pool *db.Pool, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req RegisterRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		req.Email = strings.TrimSpace(strings.ToLower(req.Email))
		if req.Email == "" || !strings.Contains(req.Email, "@") {
			respondError(w, http.StatusBadRequest, "valid email is required")
			return
		}

		if len(req.Password) < 8 {
			respondError(w, http.StatusBadRequest, "password must be at least 8 characters")
			return
		}

		hashedPassword, err := auth.HashPassword(req.Password)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to hash password")
			return
		}

		accountID := uuid.NewString()
		query := `
			INSERT INTO accounts (account_id, email, password_hash)
			VALUES ($1, $2, $3)
		`

		_, err = pool.Exec(r.Context(), query, accountID, req.Email, hashedPassword)
		if err != nil {
			if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique constraint") {
				respondError(w, http.StatusConflict, "an account with this email already exists")
				return
			}
			respondError(w, http.StatusInternalServerError, "failed to create account")
			return
		}

		// Issue tokens upon successful registration
		accessToken, expiresAt, err := auth.IssueAccessToken(cfg, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to issue access token")
			return
		}

		refreshToken, err := auth.IssueRefreshToken(r.Context(), pool, cfg, accountID, nil)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to issue refresh token")
			return
		}

		respondJSON(w, http.StatusCreated, AuthResponse{
			AccountID:    accountID,
			AccessToken:  accessToken,
			RefreshToken: refreshToken,
			ExpiresAt:    expiresAt,
			ExpiresIn:    int64(cfg.JWTExpiry.Seconds()),
		})
	}
}

// Login authenticates a user by email and password.
func Login(pool *db.Pool, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req RegisterRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		req.Email = strings.TrimSpace(strings.ToLower(req.Email))
		if req.Email == "" || req.Password == "" {
			respondError(w, http.StatusBadRequest, "email and password are required")
			return
		}

		var (
			accountID    string
			passwordHash string
		)

		query := `SELECT account_id, password_hash FROM accounts WHERE email = $1`
		err := pool.QueryRow(r.Context(), query, req.Email).Scan(&accountID, &passwordHash)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				respondError(w, http.StatusUnauthorized, "invalid email or password")
				return
			}
			respondError(w, http.StatusInternalServerError, "database error")
			return
		}

		ok, err := auth.VerifyPassword(passwordHash, req.Password)
		if err != nil || !ok {
			respondError(w, http.StatusUnauthorized, "invalid email or password")
			return
		}

		accessToken, expiresAt, err := auth.IssueAccessToken(cfg, accountID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to issue access token")
			return
		}

		refreshToken, err := auth.IssueRefreshToken(r.Context(), pool, cfg, accountID, nil)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to issue refresh token")
			return
		}

		respondJSON(w, http.StatusOK, AuthResponse{
			AccountID:    accountID,
			AccessToken:  accessToken,
			RefreshToken: refreshToken,
			ExpiresAt:    expiresAt,
			ExpiresIn:    int64(cfg.JWTExpiry.Seconds()),
		})
	}
}

// RefreshToken exchanges an existing refresh token for a new access token and rotated refresh token.
func RefreshToken(pool *db.Pool, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req RefreshRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		if req.RefreshToken == "" {
			respondError(w, http.StatusBadRequest, "refresh_token is required")
			return
		}

		newAccessToken, newRefreshToken, expiresAt, err := auth.RotateRefreshToken(r.Context(), pool, cfg, req.RefreshToken)
		if err != nil {
			if errors.Is(err, auth.ErrInvalidToken) || errors.Is(err, auth.ErrTokenRevoked) {
				respondError(w, http.StatusUnauthorized, err.Error())
				return
			}
			respondError(w, http.StatusInternalServerError, "failed to rotate token")
			return
		}

		claims, _ := auth.ParseAccessToken(cfg, newAccessToken)
		accountID := ""
		if claims != nil {
			accountID = claims.AccountID
		}

		respondJSON(w, http.StatusOK, AuthResponse{
			AccountID:    accountID,
			AccessToken:  newAccessToken,
			RefreshToken: newRefreshToken,
			ExpiresAt:    expiresAt,
			ExpiresIn:    int64(cfg.JWTExpiry.Seconds()),
		})
	}
}

// Logout revokes the provided refresh token.
func Logout(pool *db.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req LogoutRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		if req.RefreshToken != "" {
			_ = auth.RevokeRefreshToken(r.Context(), pool, req.RefreshToken)
		}

		respondJSON(w, http.StatusOK, map[string]string{"status": "logged out"})
	}
}

func respondJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func respondError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, map[string]string{"error": message})
}
