package mcp

import (
	"strings"
	"testing"
)

func TestCanonicalNumericIDUsesExactNumericValue(t *testing.T) {
	pairs := [][2]string{
		{`1e3`, `1000`},
		{`-1.00e+2`, `-100`},
		{`-0`, `0.000e-999999999999999999999999999999999999`},
		{`9007199254740993`, `90071992547409930e-1`},
		{"1e" + strings.Repeat("9", 50), "10e" + strings.Repeat("9", 49) + "8"},
	}
	for _, pair := range pairs {
		left, leftOK := canonicalNumericID([]byte(pair[0]))
		right, rightOK := canonicalNumericID([]byte(pair[1]))
		if !leftOK || !rightOK || left != right {
			t.Errorf("canonicalNumericID(%q) = %q (%d), %v; %q = %q (%d), %v", pair[0], left, len(left), leftOK, pair[1], right, len(right), rightOK)
		}
	}
}

func TestCanonicalNumericIDDoesNotRoundLargeOrNearbyValues(t *testing.T) {
	for _, pair := range [][2]string{
		{`9007199254740992`, `9007199254740993`},
		{"1e" + strings.Repeat("9", 50), "1e" + strings.Repeat("9", 49) + "8"},
	} {
		left, leftOK := canonicalNumericID([]byte(pair[0]))
		right, rightOK := canonicalNumericID([]byte(pair[1]))
		if !leftOK || !rightOK || left == right {
			t.Errorf("canonicalNumericID collapsed distinct values %q and %q to %q and %q", pair[0], pair[1], left, right)
		}
	}
}

func TestCanonicalNumericIDRejectsMalformedOrOversizedToken(t *testing.T) {
	for _, token := range []string{"", `+1`, `01`, `1.`, `.1`, `1e`, `--1`, `true`} {
		if key, ok := canonicalNumericID([]byte(token)); ok {
			t.Errorf("canonicalNumericID(%q) = %q, want rejection", token, key)
		}
	}
	if key, ok := canonicalNumericID([]byte("1e" + strings.Repeat("9", 127))); ok {
		t.Errorf("canonicalNumericID accepted oversized token %q", key)
	}
}
