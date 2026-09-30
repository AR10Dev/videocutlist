package model

import (
	"math"
	"testing"
)

func TestNormalize(t *testing.T) {
	cfg := DefaultWindowConfig()
	for _, tc := range []struct {
		name                                    string
		center, duration, start, length, offset int64
	}{
		{"middle grids", 2_249, 20_000, 0, 8_000, 2_249},
		{"start clamps", -1, 20_000, 0, 8_000, 0},
		{"end shifts", 19_999, 20_000, 12_000, 8_000, 7_999},
		{"short media", 50, 100, 0, 100, 50},
		{"duration addition overflow", math.MaxInt64, math.MaxInt64, math.MaxInt64 - 8_000, 8_000, 8_000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Normalize(tc.center, tc.duration, cfg)
			if err != nil {
				t.Fatal(err)
			}
			if got.StartMS != tc.start || got.DurationMS != tc.length || got.OffsetMS != tc.offset {
				t.Fatalf("Normalize() = %#v", got)
			}
		})
	}
}

func TestNormalizeRejectsInvalidInput(t *testing.T) {
	if _, err := Normalize(0, 0, DefaultWindowConfig()); err == nil {
		t.Fatal("expected duration error")
	}
	for _, cfg := range []WindowConfig{
		{BeforeMS: math.MaxInt64, AfterMS: 1, MaxMS: DefaultMaxMS, GridMS: 1},
		{MaxMS: DefaultMaxMS, GridMS: 1},
	} {
		if window, err := Normalize(0, 1000, cfg); err == nil {
			t.Fatalf("invalid window config %#v accepted: %#v", cfg, window)
		}
	}
}
