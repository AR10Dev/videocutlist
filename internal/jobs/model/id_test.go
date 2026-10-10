package model

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestNewID(t *testing.T) {
	seen := make(map[string]bool)
	for _, prefix := range []string{"j_", "b_"} {
		for range 32 {
			id, err := NewID(prefix)
			if err != nil {
				t.Fatal(err)
			}
			suffix, ok := strings.CutPrefix(id, prefix)
			if !ok || len(suffix) != 24 || strings.Contains(suffix, "=") {
				t.Fatalf("invalid opaque ID %q", id)
			}
			decoded, err := base64.RawURLEncoding.DecodeString(suffix)
			if err != nil || len(decoded) != 18 {
				t.Fatalf("invalid random payload %q: %v", suffix, err)
			}
			if seen[id] {
				t.Fatalf("duplicate ID %q", id)
			}
			seen[id] = true
		}
	}
}
