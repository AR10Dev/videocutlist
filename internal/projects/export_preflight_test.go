package projects

import (
	"context"
	"errors"
	"testing"

	exporter "videocutlist/internal/export"
	"videocutlist/internal/projects/model"
)

type captureExportPreflight struct {
	items   []model.ProjectItem
	options *model.ExportOptions
}

func (c *captureExportPreflight) PreflightItems(_ context.Context, items []model.ProjectItem, options *model.ExportOptions) (exporter.PreflightResult, error) {
	c.items = items
	if options != nil {
		copy := *options
		copy.StreamIndexes = append([]int(nil), options.StreamIndexes...)
		c.options = &copy
	}
	return exporter.PreflightResult{Allowed: true}, nil
}

func TestExportPreflightSelectsItemsAndPassesNullableOptions(t *testing.T) {
	items := []model.ProjectItem{
		{ID: "i_first", Segments: []model.Segment{{StartMS: 1, EndMS: 2}}, ExportOptions: model.ExportOptions{StreamIndexes: []int{1}}},
		{ID: "i_second", Segments: []model.Segment{{StartMS: 3, EndMS: 4}}, ExportOptions: model.ExportOptions{StreamIndexes: []int{2}}},
	}
	port := &captureExportPreflight{}
	useCase := ExportPreflightUseCase{Export: port}
	project := Project{Document: model.Document{Items: items}}

	if _, err := useCase.Preflight(t.Context(), project, ExportInput{ItemIDs: []string{"i_second"}}); err != nil {
		t.Fatal(err)
	}
	if len(port.items) != 1 || port.items[0].ID != "i_second" || port.options != nil {
		t.Fatalf("selected preflight inputs = %#v, override %#v", port.items, port.options)
	}
	port.items[0].Segments[0].EndMS = 99
	port.items[0].ExportOptions.StreamIndexes[0] = 99
	if items[1].Segments[0].EndMS != 4 || items[1].ExportOptions.StreamIndexes[0] != 2 {
		t.Fatal("preflight port received mutable project item storage")
	}

	input := ExportInput{Mode: "merge", Selection: "gaps", StreamIndexes: []int{0, 3}, CutStrategy: "precise_reencode", Container: "mkv", FilenameTemplate: "one-{segment}.{ext}"}
	if _, err := useCase.Preflight(t.Context(), Project{Document: model.Document{Items: items[:1]}}, input); err != nil {
		t.Fatal(err)
	}
	if len(port.items) != 1 || port.options == nil || port.options.Mode != input.Mode || port.options.Selection != input.Selection || port.options.CutStrategy != input.CutStrategy || port.options.Container != input.Container || port.options.FilenameTemplate != input.FilenameTemplate || len(port.options.StreamIndexes) != 2 || port.options.StreamIndexes[1] != 3 {
		t.Fatalf("single-item options override = %#v, items %#v", port.options, port.items)
	}
}

func TestExportPreflightRejectsInvalidSelectionBeforePort(t *testing.T) {
	port := &captureExportPreflight{}
	useCase := ExportPreflightUseCase{Export: port}
	project := Project{Document: model.Document{Items: []model.ProjectItem{{ID: "i_first"}}}}
	for _, test := range []struct {
		name    string
		itemIDs []string
		itemID  string
		code    string
	}{
		{name: "empty", itemIDs: []string{""}, code: "item_id_required"},
		{name: "duplicate", itemIDs: []string{"i_first", "i_first"}, itemID: "i_first", code: "item_id_duplicate"},
		{name: "unknown", itemIDs: []string{"i_missing"}, itemID: "i_missing", code: "item_id_unknown"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := useCase.Preflight(t.Context(), project, ExportInput{ItemIDs: test.itemIDs})
			itemErr, ok := errors.AsType[*ProjectItemError](err)
			if !ok || itemErr.ItemID != test.itemID || itemErr.Code != test.code {
				t.Fatalf("selection error = %v, want item %q code %q", err, test.itemID, test.code)
			}
		})
	}
	if len(port.items) != 0 {
		t.Fatalf("invalid selection reached export port: %#v", port.items)
	}
}
