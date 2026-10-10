package view

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"
	testsupport "videocutlist/internal/testsupport"

	store "videocutlist/internal/db"
	exporter "videocutlist/internal/export"
	jobqueue "videocutlist/internal/jobs/model"
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/projects/model"
)

type unifiedJobsStub struct{ job jobqueue.Job }

func (s unifiedJobsStub) Get(context.Context, string) (jobqueue.Job, error)    { return s.job, nil }
func (s unifiedJobsStub) Cancel(context.Context, string) (jobqueue.Job, error) { return s.job, nil }

func TestJobUseCaseMapsSafeScanResults(t *testing.T) {
	got, err := (JobUseCase{Jobs: unifiedJobsStub{job: jobqueue.Job{
		ID: "j_scanresult1234", Kind: jobqueue.JobScan, State: jobqueue.JobFailed,
		ErrorCode:  sql.NullString{Valid: true, String: "/tmp/private"},
		ResultJSON: sql.NullString{Valid: true, String: `{"library":{"state":"ready_with_media"},"../../secret":{"state":"failed","errorCode":"/tmp/root"},"bad":{"state":"unknown"}}`},
	}}}).Get(t.Context(), "j_scanresult1234")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.RootResults) != 1 || got.RootResults["library"].State != librarymedia.LibraryReadyWithMedia || got.ErrorCode != nil {
		t.Fatalf("job = %#v", got)
	}
}

func TestJobUseCasePreservesDetectionLifecycle(t *testing.T) {
	created := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	updated := created.Add(time.Second)
	for _, test := range []struct {
		state    jobqueue.JobState
		progress float64
	}{
		{jobqueue.JobQueued, 0},
		{jobqueue.JobRunning, .5},
		{jobqueue.JobSucceeded, 1},
	} {
		t.Run(string(test.state), func(t *testing.T) {
			record := jobqueue.Job{
				ID: "j_detection1234", Kind: jobqueue.JobDetect, State: test.state, Revision: 4,
				ProjectID: "p_project", ProjectItemID: "i_item", BatchID: "b_detection1234",
				RequestJSON: `{"mediaId":"m_media","projectRevision":7,"kind":"scene"}`,
				CreatedAt:   created, UpdatedAt: updated,
			}
			got, err := (JobUseCase{Jobs: unifiedJobsStub{job: record}}).Get(t.Context(), record.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Progress != test.progress || got.Revision != record.Revision || !got.CreatedAt.Equal(created) || !got.UpdatedAt.Equal(updated) || got.ProjectID != record.ProjectID || got.ProjectRevision != 7 {
				t.Fatalf("detection %s lifecycle = %#v", test.state, got)
			}
		})
	}
}

func TestJobUseCaseCancelsThroughUnifiedStore(t *testing.T) {
	database, err := store.OpenDatabase(t.Context(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	jobs, err := testsupport.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.Create(t.Context(), jobqueue.Job{ID: "j_aaaaaaaaaaaa", BatchID: "b_aaaaaaaaaaaa", Kind: jobqueue.JobScan, RequestJSON: `{}`}); err != nil {
		t.Fatal(err)
	}
	if err := (JobUseCase{Jobs: jobs}).Cancel(t.Context(), "j_aaaaaaaaaaaa"); err != nil {
		t.Fatal(err)
	}
	job, err := jobs.Get(t.Context(), "j_aaaaaaaaaaaa")
	if err != nil || job.State != jobqueue.JobCancelled {
		t.Fatalf("cancelled job = %#v, %v", job, err)
	}
}

func TestExportJobResultIsSafeAndStateCompatible(t *testing.T) {
	retainUntil := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)
	record := jobqueue.Job{ID: "j_aaaaaaaaaaaa", Kind: jobqueue.JobExport, State: jobqueue.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"export.mkv","sizeBytes":42,"retainUntil":"` + retainUntil.Format(time.RFC3339) + `","appliedStrategies":[{"segment":1,"outputName":"export.mkv","strategy":"hybrid_smart_cut"},{"segment":2,"strategy":"stream_copy"}],"warnings":[{"message":"Cut may start at an earlier keyframe."}],"outputDir":"/exports/private","stderr":"secret"}`, Valid: true}}
	job := FromRecord(record)
	if job.Result == nil || job.Result.OutputName != "export.mkv" || len(job.Result.OutputNames) != 0 || job.Result.SizeBytes != 42 || !job.Result.RetainUntil.Equal(retainUntil) || job.AppliedStrategy != "" || len(job.Result.AppliedStrategies) != 2 || job.Result.AppliedStrategies[0].OutputName != "export.mkv" || job.Result.AppliedStrategies[1].Segment != 2 || job.Result.AppliedStrategies[1].Strategy != "stream_copy" || len(job.Warnings) != 1 || job.Warnings[0] != "Cut may start at an earlier keyframe." || job.ErrorCode != nil {
		t.Fatalf("job = %#v", job)
	}

	failed := FromRecord(jobqueue.Job{ID: record.ID, Kind: jobqueue.JobExport, State: jobqueue.JobFailed, ErrorCode: sql.NullString{String: "media_unavailable", Valid: true}, ResultJSON: record.ResultJSON})
	if failed.Result != nil || len(failed.Warnings) != 0 || failed.ErrorCode == nil || *failed.ErrorCode != "media_unavailable" {
		t.Fatalf("failed job = %#v", failed)
	}
}

func TestExportJobMalformedResultFailsClosed(t *testing.T) {
	job := FromRecord(jobqueue.Job{ID: "j_aaaaaaaaaaaa", Kind: jobqueue.JobExport, State: jobqueue.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"/exports/private.mkv","warnings":[`, Valid: true}})
	if job.Result != nil || len(job.Warnings) != 0 {
		t.Fatalf("malformed result leaked: %#v", job)
	}
	job = FromRecord(jobqueue.Job{ID: "j_aaaaaaaaaaaa", Kind: jobqueue.JobExport, State: jobqueue.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"/exports/private.mkv","sizeBytes":1,"retainUntil":"2026-08-20T12:00:00Z","warnings":[{"message":"secret"}]}`, Valid: true}})
	if job.Result != nil || len(job.Warnings) != 0 {
		t.Fatalf("unsafe result leaked: %#v", job)
	}
	job = FromRecord(jobqueue.Job{ID: "j_aaaaaaaaaaaa", Kind: jobqueue.JobExport, State: jobqueue.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"export.mkv","sizeBytes":1,"retainUntil":"2026-08-20T12:00:00Z","appliedStrategies":[{"segment":1,"outputName":"/exports/private.mkv","strategy":"stream_copy"}]}`, Valid: true}})
	if job.Result != nil {
		t.Fatalf("unsafe applied strategy leaked: %#v", job)
	}
	for _, name := range []string{".", "..", "C:export.mkv", "dir/export.mkv", `dir\\export.mkv`, "export\x00.mkv", strings.Repeat("x", 256)} {
		job = FromRecord(jobqueue.Job{ID: "j_aaaaaaaaaaaa", Kind: jobqueue.JobExport, State: jobqueue.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":` + strconv.Quote(name) + `,"sizeBytes":1,"retainUntil":"2026-08-20T12:00:00Z","warnings":[{"message":"secret"}]}`, Valid: true}})
		if job.Result != nil || len(job.Warnings) != 0 {
			t.Fatalf("unsafe %q leaked: %#v", name, job)
		}
	}

	message := strings.Repeat("x", 501)
	job = FromRecord(jobqueue.Job{ID: "j_aaaaaaaaaaaa", Kind: jobqueue.JobExport, State: jobqueue.JobSucceeded, ResultJSON: sql.NullString{String: `{"outputName":"export.mkv","sizeBytes":1,"retainUntil":"2026-08-20T12:00:00Z","warnings":[{"message":"` + message + `"}]}`, Valid: true}})
	if len(job.Warnings) != 1 || len(job.Warnings[0]) != 500 {
		t.Fatalf("warnings = %#v", job.Warnings)
	}
}

func TestSeparateExportResultRetainsAllAddressableOutputs(t *testing.T) {
	for _, count := range []int{101, 1000, 1001} {
		names := make([]string, count)
		for index := range names {
			names[index] = fmt.Sprintf("segment-%04d.mkv", index)
		}
		payload, err := json.Marshal(map[string]any{
			"container": "mkv", "outputNames": names,
			"sizeBytes": 1, "retainUntil": time.Now().Add(time.Hour),
		})
		if err != nil {
			t.Fatal(err)
		}
		record := jobqueue.Job{ID: "j_outputbound", Kind: jobqueue.JobExport, State: jobqueue.JobSucceeded, ResultJSON: sql.NullString{String: string(payload), Valid: true}}
		result := FromRecord(record).Result
		if count <= 1000 {
			if result == nil || len(result.OutputNames) != count {
				t.Fatalf("%d outputs disappeared: %#v", count, result)
			}
		} else if result != nil {
			t.Fatalf("over-bound output result accepted: %d", count)
		}
	}
}

func TestLegacyBatchJobDisplaysResolvedExportOptions(t *testing.T) {
	snapshot, err := json.Marshal(exporter.ExportSnapshot{Item: model.ProjectItem{ID: "i_aaaaaaaaaaaaaaaaaaaaaaaa"}})
	if err != nil {
		t.Fatal(err)
	}
	job := FromRecord(jobqueue.Job{ID: "j_aaaaaaaaaaaa", Kind: jobqueue.JobExport, RequestJSON: string(snapshot)})
	if job.Mode != "separate" || job.Selection != "segments" || job.Strategy != "stream_copy_preferred" || job.Container != "mkv" {
		t.Fatalf("legacy job options do not match worker defaults: %+v", job)
	}
}

func TestFromRecordPreservesPublicIdentityAndCursor(t *testing.T) {
	created := time.Date(2025, 1, 2, 3, 4, 5, 0, time.UTC)
	record := jobqueue.Job{ID: "j_aaaaaaaaaaaa", BatchID: "b_aaaaaaaaaaaa", ProjectID: "p_aaaaaaaaaaaa", ProjectItemID: "i_aaaaaaaaaaaaaaaaaaaaaaaa", Kind: jobqueue.JobDetect, State: jobqueue.JobSucceeded, Revision: 7, CreatedAt: created, UpdatedAt: created, RequestJSON: `{"mediaId":"m_aaaaaaaaaaaa","projectRevision":4,"kind":"silence"}`, ResultJSON: sql.NullString{String: `[]`, Valid: true}}
	got := FromRecord(record)
	if got.ID != record.ID || got.BatchID != record.BatchID || got.ProjectItemID != record.ProjectItemID || got.ProjectID != record.ProjectID || got.Revision != record.Revision {
		t.Fatalf("identity projection = %#v", got)
	}
	if got.SnapshotCursor() != "j_aaaaaaaaaaaa:7" || got.Progress != 1 || got.CreatedAt != created {
		t.Fatalf("observation projection = %#v", got)
	}
}

func TestFromRecordKeepsImportSucceededOnlyProgress(t *testing.T) {
	for _, state := range []jobqueue.JobState{jobqueue.JobQueued, jobqueue.JobRunning, jobqueue.JobSucceeded, jobqueue.JobFailed} {
		got := FromRecord(jobqueue.Job{ID: "j_aaaaaaaaaaaa", Kind: jobqueue.JobScan, State: state})
		want := float64(0)
		if state == jobqueue.JobSucceeded {
			want = 1
		}
		if got.Progress != want {
			t.Errorf("state %s progress = %v, want %v", state, got.Progress, want)
		}
	}
}
