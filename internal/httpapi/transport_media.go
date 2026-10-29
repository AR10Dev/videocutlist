package httpapi

import (
	"errors"
	"net/http"

	"github.com/oapi-codegen/nullable"
	"videocutlist/internal/httpapi/transport"
	librarymedia "videocutlist/internal/library/media"
)

var errMediaIntegerRange = errors.New("media value exceeds transport integer range")

func mediaToTransport(media librarymedia.Media) (transport.Media, error) {
	duration := int(media.DurationMS)
	sizeBytes := int(media.SizeBytes)
	if int64(duration) != media.DurationMS || int64(sizeBytes) != media.SizeBytes {
		return transport.Media{}, errMediaIntegerRange
	}
	return transport.Media{
		Id: media.ID, Name: media.Name, DurationMs: duration, SizeBytes: sizeBytes,
		Container: media.Container, Streams: media.Streams, Etag: media.ETag,
	}, nil
}

func mediaItemsToTransport(items []librarymedia.Media) ([]transport.Media, error) {
	if items == nil {
		return nil, nil
	}
	mapped := make([]transport.Media, len(items))
	for i, item := range items {
		value, err := mediaToTransport(item)
		if err != nil {
			return nil, err
		}
		mapped[i] = value
	}
	return mapped, nil
}

func mediaPageToTransport(page librarymedia.MediaPage) (transport.MediaPage, error) {
	items, err := mediaItemsToTransport(page.Items)
	if err != nil {
		return transport.MediaPage{}, err
	}
	mapped := transport.MediaPage{Items: items}
	if page.NextCursor == nil {
		mapped.NextCursor = nullable.NewNullNullable[string]()
	} else {
		mapped.NextCursor = nullable.NewNullableWithValue(*page.NextCursor)
	}
	return mapped, nil
}

func folderPageToTransport(page librarymedia.FolderPage) (transport.FolderPage, error) {
	items, err := mediaItemsToTransport(page.Items)
	if err != nil {
		return transport.FolderPage{}, err
	}
	var folders []transport.FolderNode
	if page.Folders != nil {
		folders = make([]transport.FolderNode, len(page.Folders))
		for i, folder := range page.Folders {
			folders[i] = transport.FolderNode{Id: folder.ID, Label: folder.Label}
		}
	}
	mapped := transport.FolderPage{Folders: folders, Items: items}
	if page.NextCursor == nil {
		mapped.NextCursor = nullable.NewNullNullable[string]()
	} else {
		mapped.NextCursor = nullable.NewNullableWithValue(*page.NextCursor)
	}
	return mapped, nil
}

func importJobToTransport(job librarymedia.ImportJob) transport.ImportJob {
	mapped := transport.ImportJob{
		Id: job.ID, State: transport.ImportJobState(job.State), Progress: job.Progress, Indexed: job.Indexed,
	}
	if job.ErrorCode != "" {
		mapped.ErrorCode = new(job.ErrorCode)
	}
	if len(job.RootResults) > 0 {
		rootResults := make(map[string]struct {
			ErrorCode *transport.ImportJobRootResultsErrorCode `json:"errorCode,omitempty"`
			State     transport.ImportJobRootResultsState      `json:"state"`
		}, len(job.RootResults))
		for alias, result := range job.RootResults {
			mappedResult := struct {
				ErrorCode *transport.ImportJobRootResultsErrorCode `json:"errorCode,omitempty"`
				State     transport.ImportJobRootResultsState      `json:"state"`
			}{State: transport.ImportJobRootResultsState(result.State)}
			if result.ErrorCode != "" {
				code := transport.ImportJobRootResultsErrorCode(result.ErrorCode)
				mappedResult.ErrorCode = &code
			}
			rootResults[alias] = mappedResult
		}
		mapped.RootResults = &rootResults
	}
	if len(job.ValidationErrors) > 0 {
		mapped.ValidationErrors = new(job.ValidationErrors)
	}
	return mapped
}

func destinationsToTransport(destinations []DestinationMetadata, capabilities DestinationCapabilities) transport.DestinationsResponse {
	mapped := transport.DestinationsResponse{
		Capabilities: transport.DestinationCapabilities{SaveBesideSource: capabilities.SaveBesideSource},
	}
	if destinations != nil {
		mapped.Destinations = make([]transport.Destination, len(destinations))
		for i, destination := range destinations {
			mappedDestination := transport.Destination{
				Id: destination.ID, Label: destination.Label, Kind: transport.DestinationKind(destination.Kind),
			}
			if destination.Description != "" {
				mappedDestination.Description = new(destination.Description)
			}
			if destination.Retention != "" {
				mappedDestination.Retention = new(destination.Retention)
			}
			mapped.Destinations[i] = mappedDestination
		}
	}
	return mapped
}

func waveformToTransport(result AssetResult) (transport.Waveform, error) {
	start := int(result.StartMS)
	duration := int(result.DurationMS)
	if int64(start) != result.StartMS || int64(duration) != result.DurationMS {
		return transport.Waveform{}, errMediaIntegerRange
	}
	return transport.Waveform{StartMs: start, DurationMs: duration, Peaks: result.Peaks}, nil
}

func writeMediaPageJSON(writer http.ResponseWriter, requestID string, page librarymedia.MediaPage) {
	mapped, err := mediaPageToTransport(page)
	if err != nil {
		internalError(writer, requestID, err)
		return
	}
	httpx.WriteJSON(writer, http.StatusOK, mapped)
}

func writeFolderPageJSON(writer http.ResponseWriter, requestID string, page librarymedia.FolderPage) {
	mapped, err := folderPageToTransport(page)
	if err != nil {
		internalError(writer, requestID, err)
		return
	}
	httpx.WriteJSON(writer, http.StatusOK, mapped)
}

func writeMediaJSON(writer http.ResponseWriter, requestID string, media librarymedia.Media) {
	mapped, err := mediaToTransport(media)
	if err != nil {
		internalError(writer, requestID, err)
		return
	}
	httpx.WriteJSON(writer, http.StatusOK, mapped)
}

func writeImportJobJSON(writer http.ResponseWriter, status int, job librarymedia.ImportJob) {
	httpx.WriteJSON(writer, status, importJobToTransport(job))
}
