package export

import (
	"strings"
	"testing"
)

func TestSafeArtifactName(t *testing.T) {
	for _, test := range []struct {
		name  string
		valid bool
	}{
		{"clip-A_1.mkv", true},
		{"videocutlist-clips-b_123.zip", true},
		{"clip..mkv", true},
		{strings.Repeat("a", 255), true},
		{strings.Repeat("a", 256), false},
		{"", false}, {".", false}, {"..", false},
		{"nested/clip.mkv", false}, {`nested\clip.mkv`, false},
		{"café.mkv", false}, {"clip name.mkv", false},
		{"clip\n.mkv", false}, {"clip\x00.mkv", false},
		{"clip\".mkv", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := safeArtifactName(test.name); got != test.valid {
				t.Fatalf("safeArtifactName(%q) = %v, want %v", test.name, got, test.valid)
			}
		})
	}
}

func TestDownloadDestinationForResult(t *testing.T) {
	for _, test := range []struct {
		name    string
		service Service
		result  Result
		root    string
		valid   bool
	}{
		{"default", Service{OutputDir: "default"}, Result{DestinationKind: KindDownload}, "default", true},
		{"unknown ID fallback", Service{OutputDir: "default"}, Result{DestinationID: "unknown", DestinationKind: KindDownload}, "default", true},
		{"configured", Service{OutputDir: "default", Destinations: []Destination{{ID: "selected", Kind: KindDownload, Root: "configured"}}}, Result{DestinationID: "selected", DestinationKind: KindDownload}, "configured", true},
		{"first duplicate wins", Service{Destinations: []Destination{{ID: "selected", Kind: KindDownload, Root: "first"}, {ID: "selected", Kind: KindDownload, Root: "second"}}}, Result{DestinationID: "selected", DestinationKind: KindDownload}, "first", true},
		{"missing default root", Service{}, Result{DestinationKind: KindDownload}, "", false},
		{"empty configured root", Service{OutputDir: "default", Destinations: []Destination{{ID: "selected", Kind: KindDownload}}}, Result{DestinationID: "selected", DestinationKind: KindDownload}, "", false},
		{"kind mismatch", Service{OutputDir: "default", Destinations: []Destination{{ID: "selected", Kind: KindArchive, Root: "archive"}}}, Result{DestinationID: "selected", DestinationKind: KindDownload}, "archive", false},
		{"archive result", Service{Destinations: []Destination{{ID: "selected", Kind: KindArchive, Root: "archive"}}}, Result{DestinationID: "selected", DestinationKind: KindArchive}, "archive", false},
		{"source adjacent result", Service{Destinations: []Destination{{ID: "selected", Kind: KindSourceAdjacent, Root: "source"}}}, Result{DestinationID: "selected", DestinationKind: KindSourceAdjacent}, "source", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			destination, valid := test.service.destinationForResult(test.result)
			if valid != test.valid || destination.Root != test.root {
				t.Fatalf("destination = %+v, %v; want root %q, valid %v", destination, valid, test.root, test.valid)
			}
		})
	}
}
