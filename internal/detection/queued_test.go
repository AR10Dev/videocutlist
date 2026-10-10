package detection

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
	testsupport "videocutlist/internal/testsupport"

	dbstore "videocutlist/internal/db"
	jobservice "videocutlist/internal/jobs"
	jobs "videocutlist/internal/jobs/model"
	"videocutlist/internal/library/media"
	"videocutlist/internal/preview"
	"videocutlist/internal/projects/model"
)

type queuedCatalog struct {
	item media.Media
	err  error
	gets int
}

func (c *queuedCatalog) Get(context.Context, string) (media.Media, error) {
	c.gets++
	return c.item, c.err
}
func (*queuedCatalog) List(context.Context, string, int) (media.MediaPage, error) {
	return media.MediaPage{}, nil
}
func (*queuedCatalog) Browse(context.Context, string, string, int) (media.FolderPage, error) {
	return media.FolderPage{}, nil
}
func (*queuedCatalog) Refresh(context.Context) error { return nil }
func (*queuedCatalog) Preview(context.Context, preview.PreviewSpec) (preview.TranscodeSpec, error) {
	return preview.TranscodeSpec{}, nil
}

type queuedDetector func(context.Context, Request) ([]model.Candidate, error)

func (f queuedDetector) Detect(ctx context.Context, request Request) ([]model.Candidate, error) {
	return f(ctx, request)
}

func TestQueuedExecutorRejectsMalformedAndInvalidRequests(t *testing.T) {
	for _, test := range []struct {
		name       string
		request    string
		wantSyntax bool
	}{
		{name: "malformed", request: "{", wantSyntax: true},
		{name: "invalid", request: `{"mediaId":"m","projectRevision":1,"kind":"invalid"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			catalog := &queuedCatalog{}
			detectorCalls := 0
			executor := QueuedExecutor{
				Jobs: newDetectionJobsStore(t), Catalog: catalog,
				Detector: queuedDetector(func(context.Context, Request) ([]model.Candidate, error) {
					detectorCalls++
					return nil, nil
				}),
			}
			err := executor.Run(t.Context(), jobs.Job{RequestJSON: test.request})
			if err == nil {
				t.Fatal("executor accepted invalid request")
			}
			if test.wantSyntax {
				if _, ok := errors.AsType[*json.SyntaxError](err); !ok {
					t.Fatalf("malformed request error = %T %v, want JSON syntax error", err, err)
				}
			} else if err.Error() != "invalid detection request" {
				t.Fatalf("invalid request error = %v", err)
			}
			if catalog.gets != 0 || detectorCalls != 0 {
				t.Fatalf("invalid request reached downstream: catalog gets=%d detector calls=%d", catalog.gets, detectorCalls)
			}
		})
	}
}

func TestQueuedExecutorRequiresNonemptyMatchingSourceFingerprint(t *testing.T) {
	for _, test := range []struct {
		name        string
		fingerprint string
		etag        string
	}{
		{name: "empty", fingerprint: "", etag: "etag"},
		{name: "mismatch", fingerprint: "old-etag", etag: "etag"},
	} {
		t.Run(test.name, func(t *testing.T) {
			store, job := runningDetectionJob(t)
			job.RequestJSON = queuedRequestJSON(t, test.fingerprint)
			catalog := &queuedCatalog{item: media.Media{ID: "m", ETag: test.etag}}
			detectorCalls := 0
			executor := QueuedExecutor{Jobs: store, Catalog: catalog, Detector: queuedDetector(func(context.Context, Request) ([]model.Candidate, error) {
				detectorCalls++
				return nil, nil
			})}
			if err := executor.Run(t.Context(), job); !errors.Is(err, jobservice.ErrSourceChanged) {
				t.Fatalf("executor error = %v, want source changed", err)
			}
			if catalog.gets != 1 || detectorCalls != 0 {
				t.Fatalf("fingerprint check reached unexpected boundaries: catalog gets=%d detector calls=%d", catalog.gets, detectorCalls)
			}
		})
	}
}

func TestQueuedExecutorRestoresIdentityAndSerializesCandidates(t *testing.T) {
	store, job := runningDetectionJob(t)
	candidate := model.Candidate{ID: "c_silence_100", MediaID: "m", StartMS: 100, EndMS: 200, Source: model.DetectSilence}
	var received Request
	executor := QueuedExecutor{
		Jobs: store, Catalog: &queuedCatalog{item: media.Media{ID: "m", ETag: "etag"}},
		Detector: queuedDetector(func(_ context.Context, request Request) ([]model.Candidate, error) {
			received = request
			return []model.Candidate{candidate}, nil
		}),
	}
	if err := executor.Run(t.Context(), job); err != nil {
		t.Fatal(err)
	}
	if received.ProjectID != job.ProjectID {
		t.Fatalf("detector project ID=%q, want %q", received.ProjectID, job.ProjectID)
	}
	completed, err := store.Get(t.Context(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	var got []model.Candidate
	if err := json.Unmarshal([]byte(completed.ResultJSON.String), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != candidate.ID {
		t.Fatalf("persisted candidates=%#v", got)
	}
}

func TestQueuedExecutorPropagatesDetectionCancellation(t *testing.T) {
	store, job := runningDetectionJob(t)
	ctx, cancel := context.WithCancel(t.Context())
	executor := QueuedExecutor{
		Jobs: store, Catalog: &queuedCatalog{item: media.Media{ID: "m", ETag: "etag"}},
		Detector: queuedDetector(func(ctx context.Context, _ Request) ([]model.Candidate, error) {
			cancel()
			<-ctx.Done()
			return nil, ctx.Err()
		}),
	}
	if err := executor.Run(ctx, job); !errors.Is(err, context.Canceled) {
		t.Fatalf("executor error=%v, want cancellation", err)
	}
	unchanged, err := store.Get(t.Context(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.State != jobs.JobRunning {
		t.Fatalf("executor changed durable state after detector cancellation: %s", unchanged.State)
	}
}

func TestQueuedExecutorTerminalCASDoesNotOverwriteCancellation(t *testing.T) {
	store, job := runningDetectionJob(t)
	candidate := model.Candidate{ID: "c_silence_100", MediaID: "m", StartMS: 100, EndMS: 200, Source: model.DetectSilence}
	var cancelErr error
	executor := QueuedExecutor{
		Jobs: store, Catalog: &queuedCatalog{item: media.Media{ID: "m", ETag: "etag"}},
		Detector: queuedDetector(func(_ context.Context, _ Request) ([]model.Candidate, error) {
			_, cancelErr = store.Cancel(t.Context(), job.ID)
			return []model.Candidate{candidate}, cancelErr
		}),
	}
	if err := executor.Run(t.Context(), job); !errors.Is(err, jobs.ErrJobState) {
		t.Fatalf("executor completion error=%v, want terminal-state CAS conflict", err)
	}
	if cancelErr != nil {
		t.Fatalf("cancel running job: %v", cancelErr)
	}
	completed, err := store.Get(t.Context(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.State != jobs.JobCancelled || completed.ResultJSON.Valid {
		t.Fatalf("terminal job was overwritten: state=%s result=%#v", completed.State, completed.ResultJSON)
	}
}

func TestAdmissionJobResultPreservesDetectionProjection(t *testing.T) {
	candidates := `[{"id":"c_silence_100","mediaId":"m","startMs":100,"endMs":200,"source":"silence"}]`
	projected := AdmissionJobResult(jobs.Job{
		ID: "j_detection0001", Kind: jobs.JobDetect, State: jobs.JobSucceeded,
		ProjectID: "p_authoritative", RequestJSON: "{",
		ResultJSON: sql.NullString{String: candidates, Valid: true},
		ErrorCode:  sql.NullString{String: "safe_error", Valid: true},
	})
	if projected.Type != "detection" || projected.ProjectID != "p_authoritative" || projected.MediaID != "" || projected.State != string(jobs.JobSucceeded) {
		t.Fatalf("admission projection = %#v", projected)
	}
	if len(projected.Candidates) != 1 || projected.Candidates[0].ID != "c_silence_100" || projected.ErrorCode == nil || *projected.ErrorCode != "safe_error" {
		t.Fatalf("admission result = %#v", projected)
	}

	queued := AdmissionJobResult(jobs.Job{
		ID: "j_detection0002", Kind: jobs.JobDetect, State: jobs.JobQueued,
		ProjectID: "p_authoritative", RequestJSON: `{"mediaId":"m","projectId":"p_untrusted","projectRevision":3,"kind":"silence"}`,
		ResultJSON: sql.NullString{String: candidates, Valid: true},
	})
	if queued.ProjectID != "p_authoritative" || queued.MediaID != "m" || queued.ProjectRevision != 3 || len(queued.Candidates) != 0 {
		t.Fatalf("queued admission projection = %#v", queued)
	}
}

func newDetectionJobsStore(t *testing.T) *jobservice.JobsStore {
	t.Helper()
	database, err := dbstore.OpenDatabase(t.Context(), t.TempDir()+"/jobs.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	store, err := testsupport.NewJobsStore(database)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func runningDetectionJob(t *testing.T) (*jobservice.JobsStore, jobs.Job) {
	t.Helper()
	store := newDetectionJobsStore(t)
	job, err := store.Create(t.Context(), jobs.Job{
		ID: "j_detection0001", BatchID: "b_detection0001", Kind: jobs.JobDetect,
		ProjectID: "p_authoritative", ProjectItemID: "i_detection123456789012345",
		RequestJSON: queuedRequestJSON(t, "etag"),
	})
	if err != nil {
		t.Fatal(err)
	}
	job, err = store.Start(t.Context(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	return store, job
}

func queuedRequestJSON(t *testing.T, fingerprint string) string {
	t.Helper()
	request := Request{
		MediaID: "m", ProjectItemID: "i_detection123456789012345", ProjectRevision: 2,
		Kind: model.DetectSilence, SourceFingerprint: fingerprint,
	}
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
