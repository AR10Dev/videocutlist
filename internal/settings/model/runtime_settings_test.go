package model

import (
	"math"
	"strings"
	"testing"
)

func TestRuntimeSettingsStateSnapshotsAreIsolated(t *testing.T) {
	initial := validRuntimeSettings()
	state := NewRuntimeSettingsState(initial)
	initial.MediaRoots["camera"] = "/mutated"
	initial.Destinations[0].Root = "/mutated"
	if got := state.Snapshot(); got.MediaRoots["camera"] != "/media/camera" || got.Destinations[0].Root != "/exports" {
		t.Fatalf("constructor retained caller-owned values: %#v", got)
	}

	snapshot := state.Snapshot()
	snapshot.MediaRoots["camera"] = "/snapshot"
	snapshot.Destinations[0].Root = "/snapshot"
	if got := state.Snapshot(); got.MediaRoots["camera"] != "/media/camera" || got.Destinations[0].Root != "/exports" {
		t.Fatalf("snapshot mutation changed live settings: %#v", got)
	}

	next := validRuntimeSettings()
	next.MediaRoots["camera"] = "/next"
	next.Destinations[0].Root = "/next"
	state.Replace(next)
	next.MediaRoots["camera"] = "/mutated-after-replace"
	next.Destinations[0].Root = "/mutated-after-replace"
	if got := state.Snapshot(); got.MediaRoots["camera"] != "/next" || got.Destinations[0].Root != "/next" {
		t.Fatalf("replace retained caller-owned values: %#v", got)
	}
}

func TestValidateRuntimeSettingsSafetyBoundaries(t *testing.T) {
	settings := validRuntimeSettings()
	for _, limit := range []int{1, MaxExportWorkers} {
		settings.ExportLimit = limit
		if err := ValidateRuntimeSettings(settings); err != nil {
			t.Fatalf("export limit %d rejected: %v", limit, err)
		}
	}
	for _, limit := range []int{1, MaxMediaProcesses} {
		settings.PreviewGlobalLimit = limit
		if err := ValidateRuntimeSettings(settings); err != nil {
			t.Fatalf("media process limit %d rejected: %v", limit, err)
		}
	}
	settings.PreviewGlobalLimit = MaxMediaProcesses + 1
	if err := ValidateRuntimeSettings(settings); err == nil {
		t.Fatal("accepted media process limit above ceiling")
	}
	settings = validRuntimeSettings()
	settings.PreviewBeforeMS = math.MaxInt
	settings.PreviewAfterMS = 1
	settings.PreviewMaxMS = math.MaxInt
	if err := ValidateRuntimeSettings(settings); err == nil {
		t.Fatal("accepted overflowing default preview window")
	}
	settings.PreviewBeforeMS = math.MaxInt - 1
	if err := ValidateRuntimeSettings(settings); err != nil {
		t.Fatalf("rejected exact preview window boundary: %v", err)
	}
}

func TestValidDestinationID(t *testing.T) {
	for _, id := range []string{"download", "destination-1", strings.Repeat("x", 64)} {
		if !ValidDestinationID(id) {
			t.Errorf("rejected safe destination ID %q", id)
		}
	}
	for _, id := range []string{"", " ", "../escape", `bad\\id`, "control\x7f"} {
		if ValidDestinationID(id) {
			t.Errorf("accepted unsafe destination ID %q", id)
		}
	}
}

func validRuntimeSettings() RuntimeSettings {
	return RuntimeSettings{
		MediaRoots: map[string]string{"camera": "/media/camera"},
		Destinations: []RuntimeDestination{{
			ID: "download", Label: "Downloads", Kind: "download", Root: "/exports",
		}},
		ExportLimit: 1, CacheMaxBytes: 1024, PreviewGlobalLimit: 2,
		PreviewBeforeMS: 2_000, PreviewAfterMS: 6_000, PreviewMaxMS: 15_000,
		PreviewGridMS: 500, MediaMaxFiles: 100, MediaMaxDepth: 5,
	}
}
