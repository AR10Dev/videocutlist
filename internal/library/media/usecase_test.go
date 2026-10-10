package media

import (
	"context"
	"errors"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"videocutlist/internal/library/media/index"
	"videocutlist/internal/preview"
)

type browseContextKey struct{}

type catalogStub struct {
	refreshes                  int
	refreshErr                 error
	browse                     FolderPage
	browseContext              context.Context
	browseFolder, browseCursor string
	browseLimit                int
}

func (c *catalogStub) List(context.Context, string, int) (MediaPage, error) {
	return MediaPage{}, nil
}
func (c *catalogStub) Browse(ctx context.Context, folder, cursor string, limit int) (FolderPage, error) {
	c.browseContext, c.browseFolder, c.browseCursor, c.browseLimit = ctx, folder, cursor, limit
	return c.browse, nil
}
func (c *catalogStub) Get(context.Context, string) (Media, error) { return Media{}, nil }
func (c *catalogStub) Refresh(context.Context) error              { c.refreshes++; return c.refreshErr }
func (c *catalogStub) Preview(context.Context, preview.PreviewSpec) (preview.TranscodeSpec, error) {
	return preview.TranscodeSpec{}, nil
}

func TestMediaBrowseForwardsToCatalog(t *testing.T) {
	want := FolderPage{Folders: []FolderNode{{ID: "f_opaque", Label: "clips"}}}
	catalog := &catalogStub{browse: want}
	useCase := &MediaUseCase{Catalog: catalog, Configured: true}
	ctx := context.WithValue(context.Background(), browseContextKey{}, "request")
	got, err := useCase.Browse(ctx, "f_parent", "m_cursor", 25)
	if err != nil || len(got.Folders) != 1 || got.Folders[0].ID != want.Folders[0].ID {
		t.Fatalf("browse = %#v, err = %v", got, err)
	}
	if catalog.browseContext != ctx || catalog.browseFolder != "f_parent" || catalog.browseCursor != "m_cursor" || catalog.browseLimit != 25 {
		t.Fatalf("browse arguments context=%v folder=%q cursor=%q limit=%d", catalog.browseContext, catalog.browseFolder, catalog.browseCursor, catalog.browseLimit)
	}
}

type blockingRefreshCatalog struct {
	catalogStub
	started  chan struct{}
	release  chan struct{}
	finished chan struct{}
}

func (c *blockingRefreshCatalog) Refresh(ctx context.Context) error {
	defer close(c.finished)
	close(c.started)
	select {
	case <-c.release:
		c.refreshes++
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestMediaRefreshIsSynchronous(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		catalog := &blockingRefreshCatalog{started: make(chan struct{}), release: make(chan struct{}), finished: make(chan struct{})}
		useCase := &MediaUseCase{Catalog: catalog, Configured: true}
		release := sync.OnceFunc(func() { close(catalog.release) })
		returned := make(chan error, 1)
		finished := make(chan struct{})
		defer func() {
			release()
			select {
			case <-catalog.finished:
			case <-time.After(time.Second):
				t.Error("refresh stub did not finish after release")
			}
			select {
			case <-finished:
			case <-time.After(time.Second):
				t.Error("RefreshMedia call did not finish after release")
			}
		}()
		go func() { returned <- useCase.RefreshMedia(t.Context()); close(finished) }()
		select {
		case <-catalog.started:
		case <-time.After(time.Second):
			t.Fatal("catalog refresh did not start")
		}
		// Settle every runnable goroutine before checking whether the caller returned.
		// An asynchronous wrapper cannot hide behind a descheduled completion send.
		synctest.Wait()
		select {
		case err := <-returned:
			t.Fatalf("refresh returned before catalog finished: %v", err)
		default:
		}
		release()
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Fatal("RefreshMedia did not return after catalog release")
		}
		if err := <-returned; err != nil {
			t.Fatal(err)
		}
		if catalog.refreshes != 1 {
			t.Fatalf("refreshes = %d", catalog.refreshes)
		}
	})
}

type boundedRecoveryCatalog struct {
	recoveryStarted chan struct{}
	releaseRecovery chan struct{}
	mu              sync.Mutex
	refreshes       int
}

func (c *boundedRecoveryCatalog) List(ctx context.Context, _ string, _ int) (MediaPage, error) {
	close(c.recoveryStarted)
	select {
	case <-c.releaseRecovery:
		return MediaPage{}, nil
	case <-ctx.Done():
		return MediaPage{}, ctx.Err()
	}
}
func (c *boundedRecoveryCatalog) Browse(context.Context, string, string, int) (FolderPage, error) {
	return FolderPage{}, nil
}
func (c *boundedRecoveryCatalog) Get(context.Context, string) (Media, error) { return Media{}, nil }
func (c *boundedRecoveryCatalog) Refresh(ctx context.Context) error {
	c.mu.Lock()
	c.refreshes++
	refreshes := c.refreshes
	c.mu.Unlock()
	if refreshes > 1 {
		return errors.New("newer refresh failed")
	}
	return ctx.Err()
}
func (c *boundedRecoveryCatalog) Preview(context.Context, preview.PreviewSpec) (preview.TranscodeSpec, error) {
	return preview.TranscodeSpec{}, nil
}

func TestCancelledRefreshCannotOverwriteNewerFailure(t *testing.T) {
	catalog := &boundedRecoveryCatalog{recoveryStarted: make(chan struct{}), releaseRecovery: make(chan struct{})}
	useCase := &MediaUseCase{Catalog: catalog, Configured: true}
	cancelled := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { cancelled <- useCase.RefreshMedia(ctx) }()
	cancel()
	<-catalog.recoveryStarted
	if err := useCase.RefreshMedia(context.Background()); err == nil {
		t.Fatal("newer refresh unexpectedly succeeded")
	}
	close(catalog.releaseRecovery)
	<-cancelled
	if got := useCase.Status(); got.State != LibraryFailed {
		t.Fatalf("status after newer refresh failure = %#v", got)
	}
}

func TestMediaRefreshFailureCanRetry(t *testing.T) {
	catalog := &catalogStub{refreshErr: errors.New("refresh failed")}
	useCase := &MediaUseCase{Catalog: catalog, Configured: true}
	if err := useCase.RefreshMedia(context.Background()); err == nil {
		t.Fatal("failed refresh succeeded")
	}
	catalog.refreshErr = nil
	if err := useCase.RefreshMedia(context.Background()); err != nil {
		t.Fatalf("retry = %v", err)
	}
}

type rootStatusCatalog struct {
	catalogStub
	statuses map[string]index.RootStatus
}

func (c rootStatusCatalog) RootStatuses() map[string]index.RootStatus { return c.statuses }

func TestMediaStatusIncludesRootStatuses(t *testing.T) {
	catalog := rootStatusCatalog{statuses: map[string]index.RootStatus{
		"camera": {State: "ready_with_media"},
	}}
	status := (&MediaUseCase{Catalog: &catalog, Configured: true}).Status()
	if status.Roots["camera"].State != LibraryReadyWithMedia {
		t.Fatalf("root status = %#v", status.Roots)
	}
}

func TestMediaLibraryStatusNeverExposesRefreshError(t *testing.T) {
	catalog := &catalogStub{refreshErr: errors.New("scan /private/media/clip.mp4 failed")}
	useCase := &MediaUseCase{Catalog: catalog, Configured: true}
	if err := useCase.RefreshMedia(context.Background()); err == nil {
		t.Fatal("refresh succeeded")
	}
	if got := useCase.Status(); got.State != LibraryFailed || got.Message != "Media library scan failed. Try refreshing it." {
		t.Fatalf("status = %#v", got)
	}
}
