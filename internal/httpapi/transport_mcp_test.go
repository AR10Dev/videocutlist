package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"videocutlist/internal/projects/model"
)

func TestProposalItemTransportOmitsEmptyExportStreamIndexes(t *testing.T) {
	item := model.ProjectItem{ExportOptions: model.ExportOptions{
		Mode: "merge", Selection: "segments", StreamIndexes: []int{},
	}}
	mapped, ok := proposalItemToTransport(item)
	if !ok {
		t.Fatal("proposal item did not map")
	}
	if mapped.ExportOptions.StreamIndexes != nil {
		t.Fatalf("empty stream indexes should retain the domain JSON omission: %#v", mapped.ExportOptions.StreamIndexes)
	}
	encoded, err := json.Marshal(mapped)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "streamIndexes") {
		t.Fatalf("proposal item emitted empty stream indexes: %s", encoded)
	}

	item.ExportOptions.StreamIndexes = []int{2}
	mapped, ok = proposalItemToTransport(item)
	if !ok || mapped.ExportOptions.StreamIndexes == nil || len(*mapped.ExportOptions.StreamIndexes) != 1 || (*mapped.ExportOptions.StreamIndexes)[0] != 2 {
		t.Fatalf("non-empty stream indexes changed: %#v", mapped.ExportOptions.StreamIndexes)
	}
}
