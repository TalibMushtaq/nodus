package handler

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeDisplayName(t *testing.T) {
	name, ok := normalizeDisplayName("  My NAS  ")
	require.True(t, ok)
	require.Equal(t, "My NAS", name)

	// Whitespace-only clears the name.
	name, ok = normalizeDisplayName("   ")
	require.True(t, ok)
	require.Equal(t, "", name)

	// Exactly at the cap is accepted; one over is rejected.
	_, ok = normalizeDisplayName(strings.Repeat("a", maxDisplayNameLength))
	require.True(t, ok)
	_, ok = normalizeDisplayName(strings.Repeat("a", maxDisplayNameLength+1))
	require.False(t, ok)
}

func TestNormalizeDisplayNameCountsRunes(t *testing.T) {
	// Multi-byte runes are counted as characters, not bytes, so a 64-character
	// non-ASCII name is not rejected for exceeding a byte budget.
	fits := strings.Repeat("é", maxDisplayNameLength)
	_, ok := normalizeDisplayName(fits)
	require.True(t, ok)
}
