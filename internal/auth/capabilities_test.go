package auth

import (
	"encoding/json"
	"testing"
)

func TestCapabilitiesAllowsAny(t *testing.T) {
	caps := Capabilities{
		"https://example.test/cap/editapp": {
			json.RawMessage(`{"action":["preview"],"resources":["m_allowed"]}`),
		},
	}
	if !caps.AllowsAny("preview", "m_allowed") {
		t.Fatal("matching capability was rejected")
	}
	if caps.AllowsAny("export", "m_allowed") || caps.AllowsAny("preview", "m_denied") {
		t.Fatal("non-matching capability was accepted")
	}
}
