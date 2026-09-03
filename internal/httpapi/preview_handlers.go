// Package httpapi implements HTTP transport handlers.
package httpapi

import (
	"errors"
	"io"
	"net/http"
	"strconv"

	"videocutlist/internal/projects"
	"videocutlist/internal/projects/model"
)

func (s *Server) preview(writer http.ResponseWriter, request *http.Request, media string, id string) {
	item, err := s.config.Media.Get(request.Context(), media)
	if err != nil {
		notFound(writer, id)
		return
	}
	spec, err := s.previewSpec(request, item)
	if err != nil {
		httpx.Error(writer, 422, "invalid_preview", "Preview parameters are invalid.", id)
		return
	}
	if request.Method == http.MethodHead {
		cached, err := s.config.Preview.Cached(request.Context(), spec)
		if err != nil {
			internalError(writer, id)
			return
		}
		if !cached {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		previewHeaders(writer, spec, "hit")
		writer.WriteHeader(http.StatusOK)
		return
	}
	result, err := s.config.Preview.Start(request.Context(), spec)
	if err != nil {
		httpx.Error(writer, http.StatusTooManyRequests, "preview_unavailable", "Preview is unavailable.", id)
		return
	}
	defer result.Reader.Close()
	previewHeaders(writer, PreviewSpec{StartMS: result.StartMS, WindowMS: result.DurationMS, OffsetMS: result.OffsetMS}, result.CacheStatus)
	writer.Header().Set("Content-Type", "video/mp4")
	writer.WriteHeader(http.StatusOK)
	s.metrics.Preview(result.CacheStatus)
	buffer := make([]byte, 32*1024)
	for {
		count, readErr := result.Reader.Read(buffer)
		if count > 0 {
			if _, err := writer.Write(buffer[:count]); err != nil {
				return
			}
			if flush, ok := writer.(http.Flusher); ok {
				flush.Flush()
			}
		}
		if readErr == io.EOF {
			return
		}
		if readErr != nil {
			s.metrics.Add("ffmpeg_failures_total", 1)
			return
		}
	}
}

func (s *Server) assetSpec(request *http.Request, item Media, waveform bool) (AssetSpec, error) {
	keys := []string{"startMs", "durationMs"}
	if waveform {
		keys = append(keys, "samples")
	} else {
		keys = append(keys, "count", "width")
	}
	if !queryKeys(request, keys...) {
		return AssetSpec{}, errors.New("unknown query")
	}
	q := request.URL.Query()
	start, err := requiredInt(q.Get("startMs"))
	if err != nil || start < 0 {
		return AssetSpec{}, errors.New("start")
	}
	duration, err := requiredInt(q.Get("durationMs"))
	if err != nil || duration < 1 || duration > 120000 {
		return AssetSpec{}, errors.New("duration")
	}
	spec := AssetSpec{MediaID: item.ID, StartMS: start, DurationMS: duration}
	if waveform {
		spec.Samples, err = strconv.Atoi(q.Get("samples"))
		if err != nil || spec.Samples < 16 || spec.Samples > 4096 {
			return AssetSpec{}, errors.New("samples")
		}
	} else {
		spec.Count, err = strconv.Atoi(q.Get("count"))
		if err != nil || spec.Count < 1 || spec.Count > 32 {
			return AssetSpec{}, errors.New("count")
		}
		spec.Width, err = strconv.Atoi(q.Get("width"))
		if err != nil || spec.Width < 80 || spec.Width > 320 {
			return AssetSpec{}, errors.New("width")
		}
	}
	if item.DurationMS < 1 || start >= item.DurationMS {
		return AssetSpec{}, errors.New("range")
	}
	if start+duration > item.DurationMS {
		spec.DurationMS = item.DurationMS - start
	}
	return spec, nil
}

func (s *Server) thumbnails(w http.ResponseWriter, r *http.Request, media, id string) {
	if s.config.Assets == nil {
		if s.config.Assets == nil {
			internalError(w, id)
		}
		return
	}
	item, err := s.config.Media.Get(r.Context(), media)
	if err != nil {
		notFound(w, id)
		return
	}
	spec, err := s.assetSpec(r, item, false)
	if err != nil {
		httpx.Error(w, 422, "invalid_asset", "Thumbnail parameters are invalid.", id)
		return
	}
	if assetNotModified(w, r, item, "thumbnails") {
		return
	}
	result, err := s.config.Assets.Thumbnails(r.Context(), spec)
	if err != nil {
		internalError(w, id)
		return
	}
	defer result.Reader.Close()
	w.Header().Set("Content-Type", "image/png")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, result.Reader)
}

func (s *Server) waveform(w http.ResponseWriter, r *http.Request, media, id string) {
	if s.config.Assets == nil {
		if s.config.Assets == nil {
			internalError(w, id)
		}
		return
	}
	item, err := s.config.Media.Get(r.Context(), media)
	if err != nil {
		notFound(w, id)
		return
	}
	if item.Streams["audio"] == nil {
		httpx.Error(w, 422, "no_audio", "Media has no audio stream.", id)
		return
	}
	spec, err := s.assetSpec(r, item, true)
	if err != nil {
		httpx.Error(w, 422, "invalid_asset", "Waveform parameters are invalid.", id)
		return
	}
	if assetNotModified(w, r, item, "waveform") {
		return
	}
	result, err := s.config.Assets.Waveform(r.Context(), spec)
	if errors.Is(err, projects.ErrNoAudio) {
		httpx.Error(w, 422, "no_audio", "Media has no audio stream.", id)
		return
	}
	if err != nil {
		internalError(w, id)
		return
	}
	httpx.WriteJSON(w, 200, map[string]any{"startMs": result.StartMS, "durationMs": result.DurationMS, "peaks": result.Peaks})
}

func (s *Server) previewSpec(request *http.Request, item Media) (PreviewSpec, error) {
	beforeDefault, afterDefault, maxPreview, grid := s.config.BeforeMS, s.config.AfterMS, s.config.MaxPreviewMS, s.config.GridMS
	if s.config.RuntimeSettings != nil {
		settings := s.config.RuntimeSettings.Snapshot()
		beforeDefault, afterDefault, maxPreview, grid = int64(settings.PreviewBeforeMS), int64(settings.PreviewAfterMS), int64(settings.PreviewMaxMS), int64(settings.PreviewGridMS)
	}
	if !queryKeys(request, "centerMs", "beforeMs", "afterMs", "mute") {
		return PreviewSpec{}, errors.New("unknown query")
	}
	query := request.URL.Query()
	center, err := requiredInt(query.Get("centerMs"))
	if err != nil || center < 0 {
		return PreviewSpec{}, errors.New("center")
	}
	before, err := optionalInt(query.Get("beforeMs"), beforeDefault)
	if err != nil || before < 0 {
		return PreviewSpec{}, errors.New("before")
	}
	after, err := optionalInt(query.Get("afterMs"), afterDefault)
	if err != nil || after < 0 || before+after > maxPreview {
		return PreviewSpec{}, errors.New("after")
	}
	mute := false
	if value, ok := query["mute"]; ok {
		if len(value) != 1 {
			return PreviewSpec{}, errors.New("mute")
		}
		mute, err = strconv.ParseBool(value[0])
		if err != nil {
			return PreviewSpec{}, err
		}
	}
	if item.DurationMS < 1 {
		return PreviewSpec{}, errors.New("duration")
	}
	return projects.NormalizePreview(item.ID, item.DurationMS, center, mute, model.WindowConfig{BeforeMS: before, AfterMS: after, MaxMS: maxPreview, GridMS: grid})
}
