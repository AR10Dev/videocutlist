package main

import (
	"errors"
	"reflect"
	"testing"

	"videocutlist/internal/db"
)

func TestApplyRuntimeSettingsTransactionalRestoresAfterScannerFailure(t *testing.T) {
	previous := store.RuntimeSettings{MediaRoots: map[string]string{"old": "/old"}, CacheMaxBytes: 10}
	next := store.RuntimeSettings{MediaRoots: map[string]string{"new": "/new"}, CacheMaxBytes: 20}
	var calls []string
	fail := errors.New("scanner failed")
	err := applyRuntimeSettingsTransactional(next, previous,
		func(value store.RuntimeSettings) error {
			calls = append(calls, "config:"+value.MediaRoots["old"]+value.MediaRoots["new"])
			return nil
		},
		func(value store.RuntimeSettings) error {
			calls = append(calls, "roots:"+value.MediaRoots["old"]+value.MediaRoots["new"])
			if value.MediaRoots["new"] != "" {
				return fail
			}
			return nil
		},
		func(value store.RuntimeSettings) error { calls = append(calls, "scan"); return nil },
		func(value store.RuntimeSettings) error { calls = append(calls, "preview"); return nil },
		func(value store.RuntimeSettings) error { calls = append(calls, "cache"); return nil },
	)
	if !errors.Is(err, fail) {
		t.Fatalf("error = %v", err)
	}
	want := []string{"config:/new", "roots:/new", "cache", "preview", "scan", "roots:/old", "config:/old"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %#v, want %#v", calls, want)
	}
}

func TestApplyRuntimeSettingsTransactionalRestoresAfterLaterFailure(t *testing.T) {
	previous := store.RuntimeSettings{MediaRoots: map[string]string{"old": "/old"}, CacheMaxBytes: 10}
	next := store.RuntimeSettings{MediaRoots: map[string]string{"new": "/new"}, CacheMaxBytes: 20}
	var calls []string
	fail := errors.New("preview failed")
	step := func(name string, failure bool) func(store.RuntimeSettings) error {
		return func(value store.RuntimeSettings) error {
			calls = append(calls, name+value.MediaRoots["old"]+value.MediaRoots["new"])
			if failure && value.MediaRoots["new"] != "" {
				return fail
			}
			return nil
		}
	}
	err := applyRuntimeSettingsTransactional(next, previous,
		step("config:", false), step("roots:", false), step("scan:", false), step("preview:", true), step("cache:", false))
	if !errors.Is(err, fail) {
		t.Fatalf("error = %v", err)
	}
	want := []string{"config:/new", "roots:/new", "scan:/new", "preview:/new", "cache:/old", "preview:/old", "scan:/old", "roots:/old", "config:/old"}
	if !reflect.DeepEqual(calls, want) {
		for i := range want {
			if calls[i] != want[i] {
				t.Fatalf("call %d = %q, want %q", i, calls[i], want[i])
			}
		}
		t.Fatalf("calls = %q, want %q", calls, want)
	}
}
