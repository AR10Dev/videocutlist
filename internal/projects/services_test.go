package projects

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"videocutlist/internal/db"
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/preview"
	"videocutlist/internal/projects/model"
)

type projectsStub struct {
	saves    int
	revision int64
	document model.Document
}

func cloneProjectDocument(document model.Document) model.Document {
	encoded, _ := json.Marshal(document)
	var clone model.Document
	_ = json.Unmarshal(encoded, &clone)
	return clone
}

func (p *projectsStub) Get(context.Context, string) (ProjectRecord, error) {
	return ProjectRecord{Document: cloneProjectDocument(p.document), Revision: p.revision, UpdatedAt: time.Now()}, nil
}
func (p *projectsStub) Save(_ context.Context, _ string, revision int64, document model.Document) (ProjectRecord, error) {
	if revision != p.revision {
		return ProjectRecord{}, store.ErrRevisionConflict
	}
	p.saves++
	p.revision++
	p.document = cloneProjectDocument(document)
	return ProjectRecord{Document: cloneProjectDocument(document), Revision: p.revision, UpdatedAt: time.Now()}, nil
}

func TestProjectUseCaseSavesValidatedBatchAtomically(t *testing.T) {
	mediaID := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	repository := &projectsStub{}
	catalog := &projectCatalogStub{media: map[string]librarymedia.Media{mediaID: {ID: mediaID, DurationMS: 1_000}}}
	useCase := ProjectUseCase{Repository: repository, Media: catalog}
	document := model.Document{SchemaVersion: model.ProjectSchemaVersion, Name: "Batch", Items: []model.ProjectItem{
		{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: mediaID, Segments: []model.Segment{{StartMS: 0, EndMS: 300}}, EditorState: &model.UIState{Zoom: 1}},
		{ID: "i_bbbbbbbbbbbbbbbbbbbbbbbb", MediaID: mediaID, Segments: []model.Segment{{StartMS: 400, EndMS: 900}}, ExportOptions: model.ExportOptions{Mode: "separate", Container: "mkv"}},
	}}
	ctx := t.Context()
	saved, err := useCase.Create(ctx, "p_aaaaaaaaaaaa", ProjectInput{Document: document})
	if err != nil || saved.Revision != 1 || repository.saves != 1 || len(saved.Items) != 2 {
		t.Fatalf("saved = %#v, err = %v, saves = %d", saved, err, repository.saves)
	}
	encoded, err := json.Marshal(saved)
	if err != nil || !strings.Contains(string(encoded), `"revision":1`) {
		t.Fatalf("project response = %s, err = %v", encoded, err)
	}
	if strings.Count(string(encoded), `"revision"`) != 1 {
		t.Fatalf("project response duplicates revision: %s", encoded)
	}
	next := ProjectInput{Revision: saved.Revision, Document: saved.Document}
	resaved, err := useCase.Save(ctx, "p_aaaaaaaaaaaa", next)
	if err != nil || resaved.Revision != 2 || repository.saves != 2 {
		t.Fatalf("sequential save = %#v, err = %v, saves = %d", resaved, err, repository.saves)
	}
	stale := ProjectInput{Document: saved.Document}
	if _, err := useCase.Create(ctx, "p_aaaaaaaaaaaa", stale); !errors.Is(err, store.ErrRevisionConflict) || repository.saves != 2 {
		t.Fatalf("duplicate create = %v, saves = %d", err, repository.saves)
	}
	persistedBeforeRejections := cloneProjectDocument(repository.document)
	bad := ProjectInput{Revision: resaved.Revision, Document: cloneProjectDocument(resaved.Document)}
	bad.Items[1].Segments[0].EndMS = 1_001
	if _, err := useCase.Save(ctx, "p_aaaaaaaaaaaa", bad); err == nil || repository.saves != 2 {
		t.Fatalf("out-of-range save = %v, saves = %d", err, repository.saves)
	}
	if got, err := useCase.Get(ctx, "p_aaaaaaaaaaaa"); err != nil || !reflect.DeepEqual(got.Document, persistedBeforeRejections) {
		t.Fatalf("out-of-range rejection changed document: %#v err=%v", got.Document, err)
	}
	bad = ProjectInput{Revision: resaved.Revision, Document: cloneProjectDocument(resaved.Document)}
	bad.Items[1].MediaID = "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if _, err := useCase.Save(ctx, "p_aaaaaaaaaaaa", bad); err == nil {
		t.Fatalf("missing media save = %v, saves = %d", err, repository.saves)
	} else if itemErr, ok := errors.AsType[*ProjectItemError](err); !ok || itemErr.ItemID != bad.Items[1].ID || itemErr.Code != "media_unavailable" || repository.saves != 2 {
		t.Fatalf("missing media save = %v, saves = %d", err, repository.saves)
	}
	if got, err := useCase.Get(ctx, "p_aaaaaaaaaaaa"); err != nil || got.Revision != 2 || len(got.Items) != 2 || !reflect.DeepEqual(got.Document, persistedBeforeRejections) {
		t.Fatalf("stored project = %#v, err = %v", got, err)
	}
}

type projectCatalogStub struct{ media map[string]librarymedia.Media }

func (c *projectCatalogStub) Get(_ context.Context, id string) (librarymedia.Media, error) {
	media, ok := c.media[id]
	if !ok {
		return librarymedia.Media{}, store.ErrMediaNotFound
	}
	return media, nil
}
func (*projectCatalogStub) List(context.Context, string, int) (librarymedia.MediaPage, error) {
	return librarymedia.MediaPage{}, nil
}
func (*projectCatalogStub) Browse(context.Context, string, string, int) (librarymedia.FolderPage, error) {
	return librarymedia.FolderPage{}, nil
}
func (*projectCatalogStub) Refresh(context.Context) error { return nil }
func (*projectCatalogStub) Preview(context.Context, preview.PreviewSpec) (preview.TranscodeSpec, error) {
	return preview.TranscodeSpec{}, nil
}
