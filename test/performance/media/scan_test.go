package main

import (
	"testing"

	"videocutlist/internal/jobs/model"
)

func TestScanIdempotencyKeyIsValidAndDistinctByScenario(t *testing.T) {
	b := bench{nonce: "0123456789abcdef"}
	first := b.scanIdempotencyKey("scan.import_first")
	second := b.scanIdempotencyKey("scan.rescan_unchanged")
	third := b.scanIdempotencyKey("scan.import_first")
	if !model.ValidCommandKey(first) || !model.ValidCommandKey(second) || !model.ValidCommandKey(third) {
		t.Fatalf("invalid scan command keys: %q, %q, %q", first, second, third)
	}
	if first == second || first == third || second == third {
		t.Fatalf("benchmark commands share command keys %q, %q, %q", first, second, third)
	}
}
