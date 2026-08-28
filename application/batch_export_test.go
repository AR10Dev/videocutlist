package application

import (
	"context"
	"encoding/json"
	"testing"

	"videocutlist/domain"
	"videocutlist/infrastructure/store"
)

type batchProjectRepo struct{ project ProjectRecord }

func (r batchProjectRepo) Get(context.Context, string) (ProjectRecord, error) { return r.project, nil }
func (r batchProjectRepo) Save(context.Context, string, domain.Document) (ProjectRecord, error) {
	return r.project, nil
}

type batchCatalog struct{ media map[string]Media }

func (c batchCatalog) Get(_ context.Context, id string) (Media, error)      { return c.media[id], nil }
func (c batchCatalog) List(context.Context, string, int) (MediaPage, error) { return MediaPage{}, nil }
func (c batchCatalog) Browse(context.Context, string, string, int) (FolderPage, error) {
	return FolderPage{}, nil
}
func (c batchCatalog) Refresh(context.Context) error { return nil }
func (c batchCatalog) Preview(context.Context, PreviewSpec) (domain.PreviewSpec, error) {
	return domain.PreviewSpec{}, nil
}

func TestBatchExportSnapshotsItemsInProjectOrder(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, _ := store.NewJobsStore(db)
	items := []domain.ProjectItem{{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Segments: []domain.Segment{{StartMS: 0, EndMS: 100}}, ExportOptions: domain.ExportOptions{Container: "mkv"}}, {ID: "i_bbbbbbbbbbbbbbbbbbbbbbbb", MediaID: "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Segments: []domain.Segment{{StartMS: 100, EndMS: 200}}}}
	uc := BatchExportUseCase{Projects: batchProjectRepo{}, Media: batchCatalog{media: map[string]Media{"m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": {ID: items[0].MediaID, ETag: "a", SizeBytes: 10, DurationMS: 300}, "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": {ID: items[1].MediaID, ETag: "b", SizeBytes: 20, DurationMS: 400}}}, Jobs: jobs}
	uc.Projects = batchProjectRepo{project: ProjectRecord{Document: domain.Document{SchemaVersion: 2, Name: "Batch", Items: items, Revision: 7}}}
	batchID, submitted, err := uc.Submit(context.Background(), BatchExportRequest{ProjectID: "p_aaaaaaaaaaaa", ItemIDs: []string{items[1].ID, items[0].ID}})
	if err != nil {
		t.Fatal(err)
	}
	if len(submitted) != 2 || submitted[0].State != string(store.JobQueued) || submitted[0].CreatedAt.IsZero() {
		t.Fatalf("submitted = %#v", submitted)
	}
	first, err := jobs.Get(context.Background(), submitted[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	var snapshot ExportSnapshot
	if err := json.Unmarshal([]byte(first.RequestJSON), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Item.ID != items[0].ID || snapshot.ProjectRevision != 7 || snapshot.Source.ETag != "a" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	items[0].Segments[0].EndMS = 999
	var unchanged ExportSnapshot
	_ = json.Unmarshal([]byte(first.RequestJSON), &unchanged)
	if unchanged.Item.Segments[0].EndMS == 999 {
		t.Fatal("snapshot changed after project mutation")
	}
	if state, progress, err := uc.Progress(context.Background(), batchID); err != nil || state != store.JobQueued || progress != 0 {
		t.Fatalf("progress = %s %v %v", state, progress, err)
	}
}

func TestBatchExportCancellationAndSourceFingerprint(t *testing.T) {
	db, err := store.OpenDatabase(context.Background(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	jobs, _ := store.NewJobsStore(db)
	id := "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	item := domain.ProjectItem{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", MediaID: id}
	uc := BatchExportUseCase{Projects: batchProjectRepo{project: ProjectRecord{Document: domain.Document{SchemaVersion: 2, Name: "Batch", Items: []domain.ProjectItem{item}}}}, Media: batchCatalog{media: map[string]Media{id: {ID: id, ETag: "a", SizeBytes: 1, DurationMS: 10}}}, Jobs: jobs}
	batchID, _, err := uc.Submit(context.Background(), BatchExportRequest{ProjectID: "p_aaaaaaaaaaaa"})
	if err != nil {
		t.Fatal(err)
	}
	if err := uc.Cancel(context.Background(), batchID); err != nil {
		t.Fatal(err)
	}
	state, progress, err := uc.Progress(context.Background(), batchID)
	if err != nil || state != store.JobCancelled || progress != 1 {
		t.Fatalf("cancel progress = %s %v %v", state, progress, err)
	}
	if err := ValidateSnapshot(ExportSnapshot{Source: SourceSnapshot{MediaID: id, ETag: "a", SizeBytes: 1, DurationMS: 10}}, Media{ID: id, ETag: "b", SizeBytes: 1, DurationMS: 10}); err == nil || err.Error() != "source_changed" {
		t.Fatalf("fingerprint error = %v", err)
	}
}
