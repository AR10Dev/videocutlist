package export_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	store "videocutlist/internal/db"
	exporter "videocutlist/internal/export"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

type exportRaceMediaCatalog struct {
	media projects.Media
}

func (c exportRaceMediaCatalog) List(context.Context, string, int) (projects.MediaPage, error) {
	return projects.MediaPage{}, nil
}
func (c exportRaceMediaCatalog) Browse(context.Context, string, string, int) (projects.FolderPage, error) {
	return projects.FolderPage{}, nil
}
func (c exportRaceMediaCatalog) Get(context.Context, string) (projects.Media, error) {
	return c.media, nil
}
func (c exportRaceMediaCatalog) Refresh(context.Context) error { return nil }
func (c exportRaceMediaCatalog) Preview(context.Context, projects.PreviewSpec) (model.PreviewSpec, error) {
	return model.PreviewSpec{}, nil
}

func TestBatchExportCancellationCleansPublishedArtifactsAfterCAS(t *testing.T) {
	for _, test := range []struct {
		name        string
		cancelFirst bool
	}{
		{name: "cancellation_wins", cancelFirst: true},
		{name: "success_wins", cancelFirst: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			database, err := store.OpenDatabase(t.Context(), filepath.Join(directory, "jobs.db"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := database.Close(); err != nil {
					t.Error(err)
				}
			})
			jobs, err := jobqueue.NewJobsStore(database)
			if err != nil {
				t.Fatal(err)
			}
			job := jobqueue.Job{ID: "j_pubcancel0001", BatchID: "b_pubcancel0001", Kind: jobqueue.JobExport, ProjectID: "p_pubcancel0001", ProjectItemID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", RequestJSON: `{"source":{"mediaId":"m_media","etag":"v1","sizeBytes":1,"durationMs":100}}`}
			if _, err := jobs.Create(t.Context(), job); err != nil {
				t.Fatal(err)
			}
			if _, err := jobs.Start(t.Context(), job.ID); err != nil {
				t.Fatal(err)
			}
			outputPath := filepath.Join(directory, "published.mkv")
			if err := os.WriteFile(outputPath, []byte("published output"), 0o600); err != nil {
				t.Fatal(err)
			}
			manifestPath, err := exporter.WriteManifest(directory, job.ID, exporter.KindDownload, []string{"published.mkv"}, time.Now().Add(time.Hour))
			if err != nil {
				t.Fatal(err)
			}
			artifacts := exporter.NewArtifactStore()
			artifacts.Put(job.ID, []exporter.Artifact{{Path: outputPath, Name: "published.mkv", Kind: exporter.KindDownload, Expires: time.Now().Add(time.Hour)}})
			artifacts.RegisterManifest(job.ID, manifestPath)
			removed := false
			removeArtifacts := func(id string) error {
				removed = true
				return artifacts.Remove(id)
			}
			result := `{"outputName":"published.mkv"}`
			uc := projects.BatchExportUseCase{
				Media:           exportRaceMediaCatalog{media: projects.Media{ID: "m_media", ETag: "v1", SizeBytes: 1, DurationMS: 100}},
				Jobs:            jobs,
				RemoveArtifacts: removeArtifacts,
				RunSnapshot: func(context.Context, string, projects.ExportSnapshot) (string, error) {
					if test.cancelFirst {
						if _, err := jobs.Cancel(context.Background(), job.ID); err != nil {
							return "", err
						}
					}
					return result, nil
				},
			}
			err = uc.RunQueuedSnapshot(t.Context(), job)
			stored, getErr := jobs.Get(t.Context(), job.ID)
			if getErr != nil {
				t.Fatal(getErr)
			}
			if test.cancelFirst {
				if !errors.Is(err, jobqueue.ErrJobState) || stored.State != jobqueue.JobCancelled || !removed {
					t.Fatalf("cancellation cleanup = err %v, job %#v, removed %v", err, stored, removed)
				}
				if _, statErr := os.Stat(outputPath); !os.IsNotExist(statErr) {
					t.Fatal("cancelled published output was not removed")
				}
				if _, statErr := os.Stat(manifestPath); !os.IsNotExist(statErr) {
					t.Fatal("cancelled manifest was not removed")
				}
				if _, _, openErr := artifacts.Open(job.ID, 0, time.Now()); openErr == nil {
					t.Fatal("cancelled artifact remained in the store")
				}
				return
			}
			if err != nil || stored.State != jobqueue.JobSucceeded || removed {
				t.Fatalf("success cleanup = err %v, job %#v, removed %v", err, stored, removed)
			}
			if _, statErr := os.Stat(outputPath); statErr != nil {
				t.Fatalf("successful published output was removed: %v", statErr)
			}
			if _, statErr := os.Stat(manifestPath); statErr != nil {
				t.Fatalf("successful manifest was not retained: %v", statErr)
			}
			file, _, openErr := artifacts.Open(job.ID, 0, time.Now())
			if openErr != nil {
				t.Fatalf("successful artifact unavailable: %v", openErr)
			}
			if closeErr := file.Close(); closeErr != nil {
				t.Fatal(closeErr)
			}
		})
	}
}
