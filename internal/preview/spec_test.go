package preview

import (
	"path/filepath"
	"testing"

	"videocutlist/internal/preview/cache"
)

func TestPreviewKeyAndPathAreFrozen(t *testing.T) {
	spec := TranscodeSpec{MediaID: "m_test", SizeBytes: 3, MtimeNS: 4, StartMS: 5, DurationMS: 6, Width: 1280, Height: 720, FPS: 30, Audio: true, Encoder: "software-h264-v1"}
	key := PreviewKey(spec)
	if got, want := key, "9fd5a59c541b3e2faab0b0c8a72daf70b258cfbfc6adfe6b2ae65024fece9f5f"; got != want {
		t.Fatalf("key = %s, want %s", got, want)
	}
	path, err := cache.RelativePath(key)
	if err != nil || path != filepath.Join("previews", "9f", "d5", key+".mp4") {
		t.Fatalf("path = %q, %v", path, err)
	}
}
