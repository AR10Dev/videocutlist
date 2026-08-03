package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
)

var ErrCacheMiss = errors.New("preview cache miss")

// PreviewSpec is already normalized; runners must not reinterpret its window.
type PreviewSpec struct {
	MediaID     string
	SizeBytes   int64
	MtimeNS     int64
	StartMS     int64
	DurationMS  int64
	OffsetMS    int64
	Width       int
	Height      int
	FPS         int
	Audio       bool
	Encoder     string
	EncoderImpl string
}

// PreviewKey is the frozen v1 cache identity; it intentionally contains no path.
func PreviewKey(spec PreviewSpec) string {
	payload := struct {
		V     int `json:"v"`
		Media struct {
			ID        string `json:"id"`
			SizeBytes int64  `json:"sizeBytes"`
			MtimeNS   int64  `json:"mtimeNs"`
		} `json:"media"`
		Preview struct {
			StartMS    int64  `json:"startMs"`
			DurationMS int64  `json:"durationMs"`
			Width      int    `json:"width"`
			Height     int    `json:"height"`
			FPS        int    `json:"fps"`
			Audio      bool   `json:"audio"`
			VideoCodec string `json:"videoCodec"`
			AudioCodec string `json:"audioCodec"`
			Mux        string `json:"mux"`
		} `json:"preview"`
		Encoder struct {
			Profile string `json:"profile"`
		} `json:"encoder"`
	}{V: 1}
	payload.Media.ID, payload.Media.SizeBytes, payload.Media.MtimeNS = spec.MediaID, spec.SizeBytes, spec.MtimeNS
	payload.Preview.StartMS, payload.Preview.DurationMS = spec.StartMS, spec.DurationMS
	payload.Preview.Width, payload.Preview.Height, payload.Preview.FPS, payload.Preview.Audio = spec.Width, spec.Height, spec.FPS, spec.Audio
	payload.Preview.VideoCodec, payload.Preview.AudioCodec, payload.Preview.Mux, payload.Encoder.Profile = "h264", "aac", "fmp4", spec.Encoder
	b, _ := json.Marshal(payload)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
