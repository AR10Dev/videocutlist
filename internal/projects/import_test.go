package projects

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/projects/model"
)

const (
	importMediaID = "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	importItemID  = "i_aaaaaaaaaaaaaaaaaaaaaaaa"
)

func TestProjectUseCaseImportV2AppliesDefaultsAndNeverSaves(t *testing.T) {
	repository := &projectsStub{}
	useCase := ProjectUseCase{Repository: repository, Media: importCatalog()}
	result, err := useCase.Import(t.Context(), []byte(validV2Import(`[{"startMs":0,"endMs":1000}]`)))
	if err != nil {
		t.Fatal(err)
	}
	if result.SourceFormat != "v2" || result.MediaID != "" || result.Document.SchemaVersion != model.ProjectSchemaVersion {
		t.Fatalf("result = %#v", result)
	}
	item := result.Document.Items[0]
	if item.ID != importItemID || item.Segments[0].ID == "" || !item.Segments[0].IsIncluded() {
		t.Fatalf("v2 defaults = %#v", item)
	}
	if options := item.ExportOptions; options.Mode != "separate" || options.Selection != "segments" || options.CutStrategy != "stream_copy_preferred" || options.Container != "mkv" || options.StreamIndexes != nil {
		t.Fatalf("export defaults = %#v", options)
	}
	if repository.saves != 0 {
		t.Fatalf("import saved %d projects", repository.saves)
	}
}

func TestProjectUseCaseImportLegacyIgnoresUIStateAndReturnsMediaID(t *testing.T) {
	content := fmt.Sprintf(`{"mediaId":%q,"segments":[{"startMs":10,"endMs":20}],"uiState":{"playheadMs":19,"zoom":9,"muted":true}}`, importMediaID)
	result, err := (ProjectUseCase{Media: importCatalog()}).Import(t.Context(), []byte(content))
	if err != nil {
		t.Fatal(err)
	}
	if result.SourceFormat != "legacy" || result.MediaID != importMediaID || len(result.Document.Items) != 1 {
		t.Fatalf("result = %#v", result)
	}
	item := result.Document.Items[0]
	if !strings.HasPrefix(item.ID, "i_") || len(item.ID) != 26 || item.EditorState != nil || item.Segments[0].ID == "" || !item.Segments[0].IsIncluded() {
		t.Fatalf("legacy conversion = %#v", item)
	}
	if item.ExportOptions.Container != "mkv" || item.ExportOptions.Mode != "separate" {
		t.Fatalf("legacy export defaults = %#v", item.ExportOptions)
	}
}

func TestProjectUseCaseImportIgnoresCaseAliasesAtEveryBoundary(t *testing.T) {
	legacy := `{"mediaId":"` + importMediaID + `","segments":[],"Segments":[{"endMs":100}],"uiState":{}}`
	legacyResult, err := (ProjectUseCase{Media: importCatalog()}).Import(t.Context(), []byte(legacy))
	if err != nil || len(legacyResult.Document.Items[0].Segments) != 0 {
		t.Fatalf("legacy exact-key segments = %#v, err = %v", legacyResult.Document.Items, err)
	}

	v2 := `{"schemaVersion":2,"name":"Exact","Name":"Alias","items":[{"id":"` + importItemID + `","ID":"invalid","mediaId":"` + importMediaID + `","segments":[{"id":"s_exact","startMs":0,"endMs":100,"EndMs":200}],"Segments":[{"startMs":100,"endMs":200}],"editorState":{"playheadMs":5,"zoom":1,"muted":false,"PlayheadMs":7},"EditorState":{"playheadMs":8,"zoom":1,"muted":false},"exportOptions":{"mode":"separate","selection":"segments","cutStrategy":"stream_copy_preferred","container":"mkv","Mode":"merge"},"ExportOptions":{"mode":"merge","container":"mp4"}}]}`
	v2Result, err := (ProjectUseCase{Media: importCatalog()}).Import(t.Context(), []byte(v2))
	if err != nil {
		t.Fatal(err)
	}
	item := v2Result.Document.Items[0]
	if v2Result.Document.Name != "Exact" || item.ID != importItemID || len(item.Segments) != 1 || item.Segments[0].EndMS != 100 || item.EditorState == nil || item.EditorState.PlayheadMS != 5 || item.ExportOptions.Mode != "separate" || item.ExportOptions.Container != "mkv" {
		t.Fatalf("v2 exact-key values = %#v", v2Result.Document)
	}
}

func TestProjectUseCaseImportEnforcesNameCodePointLimit(t *testing.T) {
	for _, length := range []int{120, 121} {
		t.Run(fmt.Sprint(length), func(t *testing.T) {
			name := strings.Repeat("雪", length)
			content := validV2ImportNamed(name, `[ {"id":"`+importItemID+`","mediaId":"`+importMediaID+`","segments":[{"startMs":0,"endMs":100}]} ]`)
			_, err := (ProjectUseCase{Media: importCatalog()}).Import(t.Context(), []byte(content))
			if length == 120 && err != nil {
				t.Fatalf("120-codepoint name rejected: %v", err)
			}
			if length == 121 && !errors.Is(err, ErrInvalidProjectImport) {
				t.Fatalf("121-codepoint name error = %v", err)
			}
		})
	}
}

func TestProjectUseCaseImportValidatesExportOptionTypesAndBounds(t *testing.T) {
	if result, err := (ProjectUseCase{Media: importCatalog()}).Import(t.Context(), []byte(validV2ImportWithExportOptions(`{"mode":"merge"}`))); err != nil {
		t.Fatalf("omitted export-option defaults: %v", err)
	} else if options := result.Document.Items[0].ExportOptions; options.Mode != "merge" || options.Selection != "segments" || options.CutStrategy != "stream_copy_preferred" || options.Container != "mkv" {
		t.Fatalf("omitted export-option defaults = %#v", options)
	}

	for name, options := range map[string]string{
		"null mode":                   `{"mode":null}`,
		"null selection":              `{"selection":null}`,
		"null cut strategy":           `{"cutStrategy":null}`,
		"null container":              `{"container":null}`,
		"null destination":            `{"destinationId":null}`,
		"null filename template":      `{"filenameTemplate":null}`,
		"null stream array":           `{"streamIndexes":null}`,
		"null stream index":           `{"streamIndexes":[null]}`,
		"string stream index":         `{"streamIndexes":["1"]}`,
		"fractional stream index":     `{"streamIndexes":[1.5]}`,
		"negative stream index":       `{"streamIndexes":[-1]}`,
		"overflowing stream index":    `{"streamIndexes":[9223372036854775808]}`,
		"incorrect string field type": `{"mode":[]}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := (ProjectUseCase{Media: importCatalog()}).Import(t.Context(), []byte(validV2ImportWithExportOptions(options))); !errors.Is(err, ErrInvalidProjectImport) && !errors.Is(err, ErrInvalidProject) {
				t.Fatalf("import error = %v", err)
			}
		})
	}
}

func TestProjectUseCaseImportValidatesUnicodeLabelsAndMediaAtomically(t *testing.T) {
	for _, length := range []int{200, 201} {
		t.Run(fmt.Sprint(length), func(t *testing.T) {
			label, err := json.Marshal(strings.Repeat("雪", length))
			if err != nil {
				t.Fatal(err)
			}
			content := validV2Import(`[{"startMs":0,"endMs":100,"label":` + string(label) + `}]`)
			_, err = (ProjectUseCase{Media: importCatalog()}).Import(t.Context(), []byte(content))
			if length == 200 && err != nil {
				t.Fatalf("200-codepoint label rejected: %v", err)
			}
			if length == 201 && !errors.Is(err, ErrInvalidProject) {
				t.Fatalf("201-codepoint label error = %v", err)
			}
		})
	}

	content := `{"schemaVersion":2,"name":"Test","items":[{"id":"` + importItemID + `","mediaId":"` + importMediaID + `","segments":[{"startMs":0,"endMs":100}]},{"id":"i_bbbbbbbbbbbbbbbbbbbbbbbb","mediaId":"m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","segments":[{"startMs":0,"endMs":100}]}]}`
	repository := &projectsStub{}
	_, err := (ProjectUseCase{Repository: repository, Media: importCatalog()}).Import(t.Context(), []byte(content))
	itemErr, ok := errors.AsType[*ProjectItemError](err)
	if !ok || itemErr.Code != "media_unavailable" || repository.saves != 0 {
		t.Fatalf("missing-media import = %v, saves = %d", err, repository.saves)
	}
}

func TestProjectUseCaseImportRejectsInvalidIDsRangesAndDuplicateIDs(t *testing.T) {
	for name, content := range map[string]string{
		"item id":            validV2ImportWithItem("bad", `[{"startMs":0,"endMs":100}]`),
		"missing start":      validV2Import(`[{"endMs":100}]`),
		"null start":         validV2Import(`[{"startMs":null,"endMs":100}]`),
		"invalid range":      validV2Import(`[{"startMs":100,"endMs":100}]`),
		"duplicate segments": validV2Import(`[{"id":"segment","startMs":0,"endMs":100},{"id":"segment","startMs":100,"endMs":200}]`),
		"duplicate items":    validV2ImportItems(`[ {"id":"` + importItemID + `","mediaId":"` + importMediaID + `","segments":[]}, {"id":"` + importItemID + `","mediaId":"` + importMediaID + `","segments":[]} ]`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := (ProjectUseCase{Media: importCatalog()}).Import(t.Context(), []byte(content)); !errors.Is(err, ErrInvalidProject) && !errors.Is(err, ErrInvalidProjectImport) {
				t.Fatalf("import error = %v", err)
			}
		})
	}
}

func TestProjectUseCaseImportRejectsMalformedAndOversizedJSON(t *testing.T) {
	base := validV2Import(`[{"startMs":0,"endMs":100}]`)
	invalidUTF8 := append([]byte(base), 0xff)
	for name, content := range map[string][]byte{
		"malformed": []byte("{"),
		"trailing":  []byte(base + ` {}`),
		"utf8":      invalidUTF8,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := (ProjectUseCase{Media: importCatalog()}).Import(t.Context(), content); !errors.Is(err, ErrInvalidProjectImport) {
				t.Fatalf("import error = %v", err)
			}
		})
	}
	maxSized := base + strings.Repeat(" ", MaxProjectImportBytes-len(base))
	if len(maxSized) != MaxProjectImportBytes || !utf8.ValidString(maxSized) {
		t.Fatal("maximum-sized fixture is invalid")
	}
	if _, err := (ProjectUseCase{Media: importCatalog()}).Import(t.Context(), []byte(maxSized)); err != nil {
		t.Fatalf("maximum-sized import: %v", err)
	}
	if _, err := (ProjectUseCase{Media: importCatalog()}).Import(t.Context(), []byte(maxSized+" ")); !errors.Is(err, ErrProjectImportTooLarge) {
		t.Fatalf("over-limit import error = %v", err)
	}
}

func importCatalog() *projectCatalogStub {
	return &projectCatalogStub{media: map[string]librarymedia.Media{importMediaID: {ID: importMediaID, DurationMS: 1_000}}}
}

func validV2Import(segments string) string {
	return validV2ImportWithItem(importItemID, segments)
}

func validV2ImportWithItem(id, segments string) string {
	return validV2ImportItems(`[{"id":"` + id + `","mediaId":"` + importMediaID + `","segments":` + segments + `}]`)
}

func validV2ImportItems(items string) string {
	return `{"schemaVersion":2,"name":"Imported","items":` + items + `}`
}

func validV2ImportNamed(name, items string) string {
	return `{"schemaVersion":2,"name":"` + name + `","items":` + items + `}`
}

func validV2ImportWithExportOptions(options string) string {
	return `{"schemaVersion":2,"name":"Imported","items":[{"id":"` + importItemID + `","mediaId":"` + importMediaID + `","segments":[{"startMs":0,"endMs":100}],"exportOptions":` + options + `}]}`
}
