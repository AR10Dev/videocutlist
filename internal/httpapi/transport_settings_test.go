package httpapi

import (
	"encoding/json"
	"testing"

	"videocutlist/internal/httpapi/transport"
	settingsmodel "videocutlist/internal/settings/model"
)

func TestSettingsResponseRootsAcceptLegacyAndUnknownReasonCodes(t *testing.T) {
	var response transport.SettingsResponse
	body := `{"roots":{"legacy":{"state":"ready","message":"available"},"future":{"state":"unavailable","reasonCode":"future_reason"}}}`
	if err := json.Unmarshal([]byte(body), &response); err != nil {
		t.Fatal(err)
	}
	if response.Roots["legacy"].ReasonCode != nil {
		t.Fatalf("legacy root status unexpectedly has a reason code: %#v", response.Roots["legacy"])
	}
	if code := response.Roots["future"].ReasonCode; code == nil || *code != "future_reason" {
		t.Fatalf("future reason code was not preserved: %#v", response.Roots["future"])
	}
}

func TestRuntimeSettingsTransportPreservesEmptyDestinations(t *testing.T) {
	for _, destinations := range [][]settingsmodel.RuntimeDestination{nil, {}} {
		mapped, err := runtimeSettingsToTransport(settingsmodel.RuntimeSettings{Destinations: destinations})
		if err != nil {
			t.Fatal(err)
		}
		if mapped.Destinations == nil || *mapped.Destinations == nil || len(*mapped.Destinations) != 0 {
			t.Fatalf("empty destinations changed: %#v", mapped.Destinations)
		}
	}
}
