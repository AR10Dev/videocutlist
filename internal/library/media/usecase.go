package media

import (
	"context"
	"errors"
	"sync"
	"time"
)

// MediaUseCase coordinates media browsing and refresh status for API consumers.
type MediaUseCase struct {
	Catalog    MediaCatalog
	Configured bool

	status    LibraryStatus
	mu        sync.RWMutex
	refreshID uint64
}

func (m *MediaUseCase) List(ctx context.Context, cursor string, limit int) (MediaPage, error) {
	return m.Catalog.List(ctx, cursor, limit)
}

func (m *MediaUseCase) Browse(ctx context.Context, folderID, cursor string, limit int) (FolderPage, error) {
	return m.Catalog.Browse(ctx, folderID, cursor, limit)
}

func (m *MediaUseCase) Get(ctx context.Context, id string) (Media, error) {
	return m.Catalog.Get(ctx, id)
}

func (m *MediaUseCase) RefreshMedia(ctx context.Context) error {
	if !m.Configured {
		return nil
	}
	m.mu.Lock()
	previous := m.status
	m.refreshID++
	refreshID := m.refreshID
	m.status = libraryStatus(LibraryScanning)
	m.mu.Unlock()

	if err := m.Catalog.Refresh(ctx); err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			m.restoreAfterCancellation(previous, refreshID)
		} else {
			m.setStatusForRefresh(refreshID, LibraryFailed)
		}
		return err
	}
	page, err := m.Catalog.List(ctx, "", 1)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			m.restoreAfterCancellation(previous, refreshID)
		} else {
			m.setStatusForRefresh(refreshID, LibraryFailed)
		}
		return err
	}
	if len(page.Items) == 0 {
		m.setStatusForRefresh(refreshID, LibraryReadyEmpty)
	} else {
		m.setStatusForRefresh(refreshID, LibraryReadyWithMedia)
	}
	return nil
}

const mediaStatusRecoveryTimeout = time.Second

func (m *MediaUseCase) restoreAfterCancellation(previous LibraryStatus, refreshID uint64) {
	if previous.State == LibraryReadyEmpty || previous.State == LibraryReadyWithMedia {
		m.setStatusForRefresh(refreshID, previous.State)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), mediaStatusRecoveryTimeout)
	defer cancel()
	page, err := m.Catalog.List(ctx, "", 1)
	if err == nil {
		if len(page.Items) == 0 {
			m.setStatusForRefresh(refreshID, LibraryReadyEmpty)
		} else {
			m.setStatusForRefresh(refreshID, LibraryReadyWithMedia)
		}
		return
	}
	if previous.State != "" && previous.State != LibraryScanning {
		m.setStatusForRefresh(refreshID, previous.State)
	} else {
		m.setStatusForRefresh(refreshID, LibraryReadyEmpty)
	}
}

func (m *MediaUseCase) Status() LibraryStatus {
	if !m.Configured {
		return libraryStatus(LibraryUnconfigured)
	}
	m.mu.RLock()
	status := m.status
	m.mu.RUnlock()
	if status.State == "" {
		status = libraryStatus(LibraryScanning)
	}
	if catalog, ok := m.Catalog.(RootStatusCatalog); ok {
		status.Roots = make(map[string]RootLibraryStatus)
		for alias, root := range catalog.RootStatuses() {
			status.Roots[alias] = RootLibraryStatus{State: LibraryState(root.State), ErrorCode: root.ErrorCode}
		}
	}
	return status
}

func (m *MediaUseCase) setStatusForRefresh(refreshID uint64, state LibraryState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.refreshID == refreshID {
		m.status = libraryStatus(state)
	}
}

func libraryStatus(state LibraryState) LibraryStatus {
	messages := map[LibraryState]string{
		LibraryUnconfigured:   "No media library is configured.",
		LibraryScanning:       "Scanning media library.",
		LibraryReadyEmpty:     "No supported media was found.",
		LibraryReadyWithMedia: "Media library is ready.",
		LibraryFailed:         "Media library scan failed. Try refreshing it.",
	}
	return LibraryStatus{State: state, Message: messages[state]}
}

var _ MediaService = (*MediaUseCase)(nil)
