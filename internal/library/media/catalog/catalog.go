// Package catalog adapts the media index and store to library media contracts.
package catalog

import (
	"context"
	"fmt"

	store "videocutlist/internal/db"
	librarymedia "videocutlist/internal/library/media"
	"videocutlist/internal/library/media/index"
	previewdomain "videocutlist/internal/preview"
)

type MediaCatalog struct {
	Scanner *index.Scanner
	Store   *store.MediaStore
}

func (m MediaCatalog) List(ctx context.Context, cursor string, limit int) (librarymedia.MediaPage, error) {
	page, err := m.Store.List(ctx, cursor, limit)
	if err != nil {
		return librarymedia.MediaPage{}, err
	}
	result := librarymedia.MediaPage{Items: make([]librarymedia.Media, 0, len(page.Items))}
	for _, item := range page.Items {
		record, err := m.Store.Get(ctx, item.ID)
		if err != nil {
			return librarymedia.MediaPage{}, err
		}
		result.Items = append(result.Items, media(record.Media, record.RootAlias))
	}
	if page.NextCursor != "" {
		result.NextCursor = &page.NextCursor
	}
	return result, nil
}

func (m MediaCatalog) Browse(ctx context.Context, folderID, cursor string, limit int) (librarymedia.FolderPage, error) {
	folders, items, next, err := m.Store.Browse(ctx, folderID, cursor, limit)
	if err != nil {
		return librarymedia.FolderPage{}, err
	}
	page := librarymedia.FolderPage{Folders: make([]librarymedia.FolderNode, 0, len(folders)), Items: make([]librarymedia.Media, 0, len(items))}
	for _, folder := range folders {
		page.Folders = append(page.Folders, librarymedia.FolderNode{ID: folder.ID, Label: folder.Label})
	}
	for _, item := range items {
		page.Items = append(page.Items, media(item, ""))
	}
	if next != "" {
		page.NextCursor = &next
	}
	return page, nil
}

func (m MediaCatalog) Get(ctx context.Context, id string) (librarymedia.Media, error) {
	record, err := m.Store.Get(ctx, id)
	if err != nil {
		return librarymedia.Media{}, err
	}
	return media(record.Media, record.RootAlias), nil
}

func (m MediaCatalog) Refresh(ctx context.Context) error {
	return m.Scanner.Refresh(ctx, m.Store)
}

func (m MediaCatalog) RootStatuses() map[string]index.RootStatus {
	return m.Scanner.RootStatuses()
}

// Preview validates the current source identity before deriving a spec so a
// changed file can never satisfy an older cache key (hit or miss).
func (m MediaCatalog) Preview(ctx context.Context, request previewdomain.PreviewSpec) (previewdomain.TranscodeSpec, error) {
	file, item, err := m.Scanner.Open(ctx, m.Store, request.MediaID)
	if err != nil {
		return previewdomain.TranscodeSpec{}, err
	}
	if closeErr := file.Close(); closeErr != nil {
		return previewdomain.TranscodeSpec{}, fmt.Errorf("close preview source: %w", closeErr)
	}
	return preview(item, request), nil
}

func media(item index.Media, rootID string) librarymedia.Media {
	streams := map[string]any{}
	if item.Metadata.Video != nil {
		streams["video"] = item.Metadata.Video
	}
	if item.Metadata.Audio != nil {
		streams["audio"] = item.Metadata.Audio
	}
	streams["tracks"] = item.Metadata.Streams
	return librarymedia.Media{ID: item.ID, RootID: rootID, Name: item.Name, DurationMS: item.Metadata.DurationMS, SizeBytes: item.SizeBytes, Container: item.Metadata.Container, Streams: streams, ETag: index.SourceFingerprint(item)}
}

func preview(item index.Media, request previewdomain.PreviewSpec) previewdomain.TranscodeSpec {
	return previewdomain.TranscodeSpec{MediaID: item.ID, SizeBytes: item.SizeBytes, MtimeNS: item.MtimeNS, StartMS: request.StartMS, DurationMS: request.WindowMS, OffsetMS: request.OffsetMS, Width: 1280, Height: 720, FPS: 30, Audio: !request.Mute, Encoder: "software-h264-baseline-l31-v2", EncoderImpl: "libx264"}
}
