package handler

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"math/big"
	"strings"
)

// pairingCodeAlphabet is A-Z minus I and O plus digits 2-9 (32 chars, ~5 bits
// of entropy per character). Ambiguous glyphs are excluded so codes survive
// hand-transcription. Format: NODUS-XXXX-XXXX (8 symbols, 32^8 ≈ 2^40).
const pairingCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// generatePairingCode returns a plaintext pairing code in NODUS-XXXX-XXXX
// format. CSPRNG-backed; the collision space is 32^12 ≈ 2^60.
func generatePairingCode() (string, error) {
	symbols := make([]byte, 8)
	for i := range symbols {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(pairingCodeAlphabet))))
		if err != nil {
			return "", err
		}
		symbols[i] = pairingCodeAlphabet[n.Int64()]
	}
	return "NODUS-" + string(symbols[:4]) + "-" + string(symbols[4:8]), nil
}

// normalizeCode uppercases and strips hyphens, returning the raw 8-char
// symbol string ready for hashing.
func normalizeCode(code string) string {
	return strings.ToUpper(strings.ReplaceAll(code, "-", ""))
}

// hashCode returns the lowercase hex-encoded SHA-256 of the normalized code.
func hashCode(normalized string) string {
	h := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(h[:])
}
