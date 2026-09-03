package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"videocutlist/internal/db"
)

func TestBrowserSettingsRedactsDeploymentPaths(t *testing.T) {
	settings := store.RuntimeSettings{
		MediaRoots:   map[string]string{"camera": "/srv/media/camera"},
		Destinations: []store.RuntimeDestination{{ID: "exports", Label: "Exports", Kind: "download", Root: "/srv/exports", MediaRoot: "/srv/media"}},
	}
	data, err := json.Marshal(browserSettings(settings))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "/srv/") || strings.Contains(string(data), "mediaRoots") {
		t.Fatalf("browser settings leaked deployment data: %s", data)
	}
	if !strings.Contains(string(data), "exports") {
		t.Fatalf("browser settings omitted destination alias: %s", data)
	}
}
