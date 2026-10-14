package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"videocutlist/internal/httpapi/transport"
	settingsmodel "videocutlist/internal/settings/model"
)

func TestSettingsResponseRedactsDeploymentPaths(t *testing.T) {
	settings := settingsmodel.RuntimeSettings{
		CacheMaxBytes: 9_007_199_254_741_003,
		MediaRoots:    map[string]string{"camera": "/srv/media/camera"},
		Destinations:  []settingsmodel.RuntimeDestination{{ID: "exports", Label: "Exports", Kind: "download", Root: "/srv/exports", MediaRoot: "/srv/media"}},
	}
	state := transport.Ready
	response, err := settingsResponseToTransport(settingsmodel.RuntimeSettingsRecord{
		Settings: settings, Revision: 1, SchemaVersion: 1,
	}, true, map[string]transport.SettingsRootStatus{"camera": {
		State: &state, Message: new("Media root is available to the server."), ReasonCode: new("media_root_available"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "/srv/") || strings.Contains(string(data), "mediaRoots") || strings.Contains(string(data), "mediaRoot") {
		t.Fatalf("settings response leaked deployment data: %s", data)
	}
	if !strings.Contains(string(data), "exports") || response.Settings.CacheMaxBytes != int(settings.CacheMaxBytes) {
		t.Fatalf("settings response lost safe destination metadata or cache precision: %#v", response.Settings)
	}
}
