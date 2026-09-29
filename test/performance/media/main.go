// Command media measures end-to-end production media workflows against a running server.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const header = "scenario,scale,cache,concurrency,samples,p50_ms,p95_ms,p99_ms,throughput_per_s,bytes_per_s,errors"

type options struct {
	base, token, fixture, mediaID, mediaRoot string
	repeats, concurrency, assetCardinality   int
	scanFiles                                int
	timeout                                  time.Duration
	exportSegmentMS                          int64
}
type observation struct {
	duration time.Duration
	bytes    int64
}
type series struct {
	name, scale, cache string
	concurrency        int
	values             []observation
	errors             int
}
type bench struct {
	opt    options
	client *http.Client
	rows   []*series
	media  media
	nonce  string
}
type media struct {
	ID         string                     `json:"id"`
	Name       string                     `json:"name"`
	DurationMS int64                      `json:"durationMs"`
	SizeBytes  int64                      `json:"sizeBytes"`
	Streams    map[string]json.RawMessage `json:"streams"`
}
type mediaPage struct {
	Items      []media `json:"items"`
	NextCursor *string `json:"nextCursor"`
}
type job struct {
	ID        string    `json:"id"`
	State     string    `json:"state"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	ErrorCode string    `json:"errorCode"`
	Result    *struct {
		OutputName  string   `json:"outputName"`
		OutputNames []string `json:"outputNames"`
		SizeBytes   int64    `json:"sizeBytes"`
	} `json:"result"`
}
type requestResult struct {
	body            []byte
	header          http.Header
	status          int
	first, complete time.Duration
	bytes           int64
}

func main() {
	var opt options
	flag.StringVar(&opt.base, "base", "", "running local server URL (required)")
	flag.StringVar(&opt.token, "token", os.Getenv("VIDEOCUTLIST_BENCH_TOKEN"), "bearer token (or VIDEOCUTLIST_BENCH_TOKEN; required)")
	flag.StringVar(&opt.fixture, "fixture", "test/fixtures/real-media/sintel-trailer.mp4", "fixture path used to match indexed media and optional import")
	flag.StringVar(&opt.mediaID, "media-id", "", "indexed media ID (bypass fixture-name lookup)")
	flag.StringVar(&opt.mediaRoot, "media-root", "", "external server media root; stage a unique fixture copy for first import")
	flag.IntVar(&opt.repeats, "repeats", 3, "samples per workflow")
	flag.IntVar(&opt.concurrency, "concurrency", 2, "parallel preview requests (must fit server preview limit)")
	flag.DurationVar(&opt.timeout, "timeout", 3*time.Minute, "per-operation deadline including job completion")
	flag.IntVar(&opt.assetCardinality, "asset-cardinality", 0, "opt-in number of distinct 1s waveform specs to seed before measuring warm repeats (0 disables)")
	flag.IntVar(&opt.scanFiles, "scan-files", 1, "number of staged media entries for import/rescan; 1 copies, others hardlink it (1-9000)")
	flag.Int64Var(&opt.exportSegmentMS, "export-segment-ms", 8000, "duration of each of two exported source segments")
	flag.Parse()
	if opt.base == "" || opt.token == "" || opt.repeats < 1 || opt.concurrency < 1 || opt.assetCardinality < 0 || opt.scanFiles < 1 || opt.scanFiles > 9000 || opt.timeout <= 0 || opt.exportSegmentMS < 1000 {
		fmt.Fprintln(os.Stderr, "required: --base and token (--token or VIDEOCUTLIST_BENCH_TOKEN); positive --repeats --concurrency --timeout and --export-segment-ms >= 1000; --asset-cardinality >= 0; --scan-files 1-9000")
		os.Exit(2)
	}
	u, err := url.Parse(opt.base)
	if err != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		fmt.Fprintln(os.Stderr, "--base must be a local HTTP URL without credentials or query")
		os.Exit(2)
	}
	if opt.mediaRoot != "" && opt.fixture == "" {
		fmt.Fprintln(os.Stderr, "--media-root requires --fixture")
		os.Exit(2)
	}
	if opt.scanFiles > 1 && opt.mediaRoot == "" {
		fmt.Fprintln(os.Stderr, "--scan-files > 1 requires --media-root")
		os.Exit(2)
	}
	nonce := make([]byte, 8)
	if _, err := rand.Read(nonce); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	b := &bench{opt: opt, nonce: hex.EncodeToString(nonce), client: &http.Client{Timeout: opt.timeout}}
	err = b.run()
	writer := csv.NewWriter(os.Stdout)
	_ = writer.Write(strings.Split(header, ","))
	for _, row := range b.rows {
		durations := make([]float64, 0, len(row.values))
		var total time.Duration
		var bytes int64
		for _, sample := range row.values {
			durations = append(durations, float64(sample.duration)/float64(time.Millisecond))
			total += sample.duration
			bytes += sample.bytes
		}
		sort.Float64s(durations)
		p := func(q float64) string {
			if len(durations) == 0 {
				return ""
			}
			return fmt.Sprintf("%.3f", durations[int(math.Ceil(q*float64(len(durations))))-1])
		}
		throughput, bandwidth := 0.0, 0.0
		if total > 0 {
			throughput = float64(len(durations)) / total.Seconds()
			bandwidth = float64(bytes) / total.Seconds()
		}
		_ = writer.Write([]string{row.name, row.scale, row.cache, strconv.Itoa(row.concurrency), strconv.Itoa(len(durations)), p(.5), p(.95), p(.99), fmt.Sprintf("%.3f", throughput), fmt.Sprintf("%.3f", bandwidth), strconv.Itoa(row.errors)})
	}
	writer.Flush()
	if flushErr := writer.Error(); flushErr != nil {
		fmt.Fprintln(os.Stderr, flushErr)
		os.Exit(1)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "media benchmark:", err)
		os.Exit(1)
	}
}

func (b *bench) add(name, scale, cache string, concurrency int, value observation) {
	for _, row := range b.rows {
		if row.name == name && row.scale == scale && row.cache == cache && row.concurrency == concurrency {
			row.values = append(row.values, value)
			return
		}
	}
	b.rows = append(b.rows, &series{name: name, scale: scale, cache: cache, concurrency: concurrency, values: []observation{value}})
}
func (b *bench) failure(name string, err error) error {
	b.rows = append(b.rows, &series{name: name, scale: "fixture", cache: "n/a", concurrency: 1, errors: 1})
	return fmt.Errorf("%s: %w", name, err)
}
func (b *bench) do(ctx context.Context, method, path string, payload any, headers http.Header) (requestResult, error) {
	var input io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return requestResult{}, err
		}
		input = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(b.opt.base, "/")+path, input)
	if err != nil {
		return requestResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+b.opt.token)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, values := range headers {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	start := time.Now()
	resp, err := b.client.Do(req)
	if err != nil {
		return requestResult{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	first := time.Since(start)
	var body bytes.Buffer
	n, err := io.Copy(&body, io.LimitReader(resp.Body, (64<<20)+1))
	if err != nil {
		return requestResult{}, err
	}
	if n > 64<<20 {
		return requestResult{}, errors.New("benchmark response exceeds 64 MiB limit")
	}
	result := requestResult{body: body.Bytes(), header: resp.Header, status: resp.StatusCode, first: first, complete: time.Since(start), bytes: n}
	if resp.ContentLength > n && method != http.MethodHead {
		return result, fmt.Errorf("truncated body: read %d expected %d bytes", n, resp.ContentLength)
	}
	return result, nil
}
func (b *bench) expect(ctx context.Context, method, path string, payload any, headers http.Header, status int, target any) (requestResult, error) {
	response, err := b.do(ctx, method, path, payload, headers)
	if err != nil {
		return response, err
	}
	if response.status != status {
		return response, fmt.Errorf("%s %s returned HTTP %d (expected %d): %.512s", method, path, response.status, status, response.body)
	}
	if target != nil {
		if err := json.Unmarshal(response.body, target); err != nil {
			return response, fmt.Errorf("decode %s: %w", path, err)
		}
	}
	return response, nil
}
func (b *bench) findMedia(ctx context.Context, name string, size int64) (media, error) {
	cursor := ""
	for range 10000 {
		path := "/api/v1/media?limit=100"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		var page mediaPage
		_, err := b.expect(ctx, "GET", path, nil, nil, http.StatusOK, &page)
		if err != nil {
			return media{}, err
		}
		for _, item := range page.Items {
			if item.Name == name && (size == 0 || item.SizeBytes == size) {
				return item, nil
			}
		}
		if page.NextCursor == nil {
			break
		}
		if cursor == *page.NextCursor {
			return media{}, errors.New("media pagination cursor did not advance")
		}
		cursor = *page.NextCursor
	}
	return media{}, fmt.Errorf("indexed fixture %q (%d bytes) not found", name, size)
}
func (b *bench) waitMedia(ctx context.Context, name string, size int64) (media, error) {
	for {
		item, err := b.findMedia(ctx, name, size)
		if err == nil {
			return item, nil
		}
		if !strings.Contains(err.Error(), "not found") {
			return media{}, err
		}
		select {
		case <-ctx.Done():
			return media{}, fmt.Errorf("waiting for indexed fixture: %w", ctx.Err())
		case <-time.After(200 * time.Millisecond):
		}
	}
}
func (b *bench) run() error {
	ctx, cancel := context.WithTimeout(context.Background(), b.opt.timeout)
	defer cancel()
	var err error
	if b.opt.mediaID != "" {
		_, err = b.expect(ctx, "GET", "/api/v1/media/"+url.PathEscape(b.opt.mediaID), nil, nil, 200, &b.media)
		if err != nil {
			return b.failure("media.lookup", err)
		}
		if b.media.ID != b.opt.mediaID {
			return b.failure("media.lookup", errors.New("media ID mismatch"))
		}
	} else {
		var info os.FileInfo
		info, err = os.Stat(b.opt.fixture)
		if err != nil {
			return b.failure("media.fixture", err)
		}
		b.media, err = b.waitMedia(ctx, filepath.Base(b.opt.fixture), info.Size())
		if err != nil {
			return b.failure("media.lookup", err)
		}
	}
	if b.media.DurationMS < 35000 || b.media.Streams["audio"] == nil || b.media.Streams["video"] == nil {
		return b.failure("media.fixture", fmt.Errorf("expected video+audio fixture of at least 35 seconds, got %+v", b.media))
	}
	if 2*b.opt.exportSegmentMS+1000 >= b.media.DurationMS {
		return b.failure("export.setup", fmt.Errorf("export segments exceed media duration %dms", b.media.DurationMS))
	}
	if b.opt.mediaRoot != "" {
		if err = b.importFirst(); err != nil {
			return b.failure("scan.import_first", err)
		}
	} else {
		if err = b.scan("scan.refresh"); err != nil {
			return b.failure("scan.refresh", err)
		}
		if err = b.scan("scan.rescan_unchanged"); err != nil {
			return b.failure("scan.rescan_unchanged", err)
		}
	}
	for i := range b.opt.repeats {
		center := b.window(i)
		if err = b.previewPair(center, "preview"); err != nil {
			return b.failure("preview", err)
		}
		if err = b.assets(center, i); err != nil {
			return b.failure("assets", err)
		}
	}
	if b.opt.assetCardinality > 0 {
		if err = b.assetCardinality(); err != nil {
			return b.failure("waveform.cardinality", err)
		}
	}
	if err = b.concurrent(); err != nil {
		return b.failure("preview.concurrent", err)
	}
	if err = b.exports(); err != nil {
		return b.failure("export", err)
	}
	return nil
}
func (b *bench) window(i int) int64 {
	return 12000 + int64((i*3317+int(b.nonce[0]))%int(b.media.DurationMS-24000))
}
func (b *bench) importFirst() error {
	root, err := filepath.Abs(b.opt.mediaRoot)
	if err != nil {
		return err
	}
	source, err := os.Open(b.opt.fixture)
	if err != nil {
		return err
	}
	defer func() { _ = source.Close() }()
	info, err := source.Stat()
	if err != nil {
		return err
	}
	filename := "bench-" + b.nonce + ".mp4"
	destination := filepath.Join(root, filename)
	target, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	stagedPaths := make([]string, 0, b.opt.scanFiles)
	stagedPaths = append(stagedPaths, destination)
	defer func() {
		for _, path := range stagedPaths {
			if removeErr := os.Remove(path); removeErr != nil {
				fmt.Fprintln(os.Stderr, "remove staged fixture:", removeErr)
			}
		}
	}()
	n, copyErr := io.Copy(target, source)
	closeErr := target.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if n != info.Size() {
		return fmt.Errorf("staged %d bytes, expected %d", n, info.Size())
	}
	for i := 1; i < b.opt.scanFiles; i++ {
		link := filepath.Join(root, fmt.Sprintf("bench-%s-%06d.mp4", b.nonce, i))
		if err := os.Link(destination, link); err != nil {
			return fmt.Errorf("stage linked fixture %d: %w", i, err)
		}
		stagedPaths = append(stagedPaths, link)
	}
	if err = b.scan("scan.import_first"); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), b.opt.timeout)
	defer cancel()
	staged, err := b.waitMedia(ctx, filename, n)
	if err != nil {
		return err
	}
	if staged.ID == b.media.ID {
		return errors.New("imported fixture did not receive a distinct media ID")
	}
	return b.scan("scan.rescan_unchanged")
}
func (b *bench) scan(scenario string) error {
	ctx, cancel := context.WithTimeout(context.Background(), b.opt.timeout)
	defer cancel()
	start := time.Now()
	var started job
	resp, err := b.expect(ctx, "POST", "/api/v1/media/refresh", nil, nil, http.StatusAccepted, &started)
	if err != nil {
		return err
	}
	if started.ID == "" {
		return errors.New("scan admission returned no job ID")
	}
	scale := "fixture"
	if b.opt.mediaRoot != "" && b.opt.scanFiles > 1 {
		scale = fmt.Sprintf("%d_files", b.opt.scanFiles+1)
	}
	b.add(scenario+".admission", scale, "n/a", 1, observation{resp.complete, resp.bytes})
	completed, _, err := b.poll(ctx, started.ID, nil)
	if err != nil {
		return err
	}
	if completed.State != "succeeded" {
		return fmt.Errorf("scan %s: %s", started.ID, completed.State)
	}
	b.add(scenario+".completed", scale, "n/a", 1, observation{time.Since(start), 0})
	return nil
}
func (b *bench) poll(ctx context.Context, id string, onRunning func() error) (job, *time.Time, error) {
	var runningAt *time.Time
	for {
		var current job
		_, err := b.expect(ctx, "GET", "/api/v1/jobs/"+url.PathEscape(id), nil, nil, 200, &current)
		if err != nil {
			return job{}, runningAt, err
		}
		if current.ID != id {
			return job{}, runningAt, errors.New("job ID mismatch")
		}
		if current.State == "running" && runningAt == nil {
			when := current.UpdatedAt
			runningAt = &when
			if onRunning != nil {
				if err := onRunning(); err != nil {
					return job{}, runningAt, err
				}
				onRunning = nil
			}
		}
		switch current.State {
		case "succeeded":
			return current, runningAt, nil
		case "failed", "cancelled":
			return current, runningAt, fmt.Errorf("job %s %s (%s)", id, current.State, current.ErrorCode)
		case "queued", "running":
		default:
			return current, runningAt, fmt.Errorf("job %s unknown state %q", id, current.State)
		}
		select {
		case <-ctx.Done():
			return current, runningAt, ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}
func (b *bench) previewPath(center int64) string {
	return fmt.Sprintf("/api/v1/media/%s/preview?centerMs=%d&beforeMs=1000&afterMs=1000", url.PathEscape(b.media.ID), center)
}
func (b *bench) preview(ctx context.Context, path, expected string) (requestResult, error) {
	resp, err := b.expect(ctx, "GET", path, nil, nil, 200, nil)
	if err != nil {
		return resp, err
	}
	if got := resp.header.Get("X-Preview-Cache"); got != expected {
		return resp, fmt.Errorf("preview cache=%q, expected %q", got, expected)
	}
	if resp.header.Get("Content-Type") != "video/mp4" || resp.bytes < 1024 || len(resp.body) < 8 || string(resp.body[4:8]) != "ftyp" {
		return resp, fmt.Errorf("invalid complete preview: type %q bytes %d", resp.header.Get("Content-Type"), resp.bytes)
	}
	return resp, nil
}
func (b *bench) previewPair(center int64, prefix string) error {
	ctx, cancel := context.WithTimeout(context.Background(), b.opt.timeout)
	defer cancel()
	path := b.previewPath(center)
	_, err := b.expect(ctx, http.MethodHead, path, nil, nil, http.StatusNotFound, nil)
	if err != nil {
		return fmt.Errorf("cold preview HEAD: %w", err)
	}
	var hitHeaders http.Header
	for _, state := range []string{"miss", "hit"} {
		resp, err := b.preview(ctx, path, state)
		if err != nil {
			return err
		}
		if state == "hit" {
			hitHeaders = resp.header
		}
		b.add(prefix+".ttfb", "2s", state, 1, observation{resp.first, 0})
		b.add(prefix+".complete", "2s", state, 1, observation{resp.complete, resp.bytes})
	}
	// GET has already proved this exact preview warm; HEAD measures validation
	// and headers without transferring the preview body.
	head, err := b.expect(ctx, http.MethodHead, path, nil, nil, http.StatusOK, nil)
	if err != nil {
		return fmt.Errorf("warm preview HEAD: %w", err)
	}
	if head.header.Get("X-Preview-Cache") != "hit" || head.bytes != 0 || len(head.body) != 0 {
		return fmt.Errorf("warm preview HEAD: cache=%q bytes=%d", head.header.Get("X-Preview-Cache"), head.bytes)
	}
	for _, key := range []string{"X-Preview-Start", "X-Preview-Duration", "X-Preview-Offset"} {
		if head.header.Get(key) == "" || head.header.Get(key) != hitHeaders.Get(key) {
			return fmt.Errorf("warm preview HEAD %s=%q, GET hit=%q", key, head.header.Get(key), hitHeaders.Get(key))
		}
	}
	b.add(prefix+".head.complete", "2s", "hit", 1, observation{head.complete, 0})
	return nil
}
func (b *bench) assets(center int64, i int) error {
	ctx, cancel := context.WithTimeout(context.Background(), b.opt.timeout)
	defer cancel()
	base := "/api/v1/media/" + url.PathEscape(b.media.ID)
	start := center + int64(i%3)
	for _, asset := range []struct{ name, path string }{
		{"thumbnails", fmt.Sprintf("%s/thumbnails?startMs=%d&durationMs=1000&count=1&width=80", base, start)},
		{"waveform", fmt.Sprintf("%s/waveform?startMs=%d&durationMs=1000&samples=64", base, start)},
	} {
		first, err := b.expect(ctx, "GET", asset.path, nil, nil, 200, nil)
		if err != nil {
			return err
		}
		etag := first.header.Get("ETag")
		if etag == "" {
			return fmt.Errorf("%s lacks ETag", asset.name)
		}
		if asset.name == "thumbnails" {
			if len(first.body) < 8 || !bytes.Equal(first.body[:8], []byte("\x89PNG\r\n\x1a\n")) {
				return errors.New("invalid PNG thumbnail")
			}
		}
		if asset.name == "waveform" {
			var value struct {
				Peaks []float64 `json:"peaks"`
			}
			if err := json.Unmarshal(first.body, &value); err != nil {
				return err
			}
			if len(value.Peaks) != 64 {
				return fmt.Errorf("waveform has %d peaks", len(value.Peaks))
			}
			for _, v := range value.Peaks {
				if v < 0 || v > 1 || math.IsNaN(v) {
					return errors.New("invalid waveform peak")
				}
			}
		}
		b.add(asset.name+".complete", "1s", "new_spec_unverified", 1, observation{first.complete, first.bytes})
		warm, err := b.expect(ctx, "GET", asset.path, nil, nil, 200, nil)
		if err != nil {
			return err
		}
		if !bytes.Equal(warm.body, first.body) {
			return fmt.Errorf("%s changed between identical requests", asset.name)
		}
		b.add(asset.name+".complete", "1s", "repeat_same_spec", 1, observation{warm.complete, warm.bytes})
		conditional, err := b.expect(ctx, "GET", asset.path, nil, http.Header{"If-None-Match": []string{etag}}, 304, nil)
		if err != nil {
			return err
		}
		if conditional.header.Get("ETag") != etag || conditional.bytes != 0 {
			return fmt.Errorf("%s invalid conditional response", asset.name)
		}
		b.add(asset.name+".revalidate", "1s", "304_verified", 1, observation{conditional.complete, 0})
	}
	return nil
}

// assetCardinality isolates the warm asset read after seeding distinct cache
// keys. HTTP has no asset hit indicator, so this measures repeated identical
// requests after seeding, not a guaranteed on-disk hit under cache pressure.
func (b *bench) assetCardinality() error {
	n := b.opt.assetCardinality
	if int64(n) > b.media.DurationMS-2000 {
		return fmt.Errorf("asset cardinality %d exceeds media's %d available 1s windows", n, b.media.DurationMS-2000)
	}
	base := "/api/v1/media/" + url.PathEscape(b.media.ID)
	var path string
	var seeded requestResult
	for i := range n {
		path = fmt.Sprintf("%s/waveform?startMs=%d&durationMs=1000&samples=64", base, 1000+i)
		ctx, cancel := context.WithTimeout(context.Background(), b.opt.timeout)
		response, err := b.expect(ctx, http.MethodGet, path, nil, nil, http.StatusOK, nil)
		cancel()
		if err != nil {
			return fmt.Errorf("seed waveform spec %d/%d: %w", i+1, n, err)
		}
		if response.header.Get("Content-Type") != "application/json; charset=utf-8" || len(response.body) == 0 {
			return fmt.Errorf("seed waveform spec %d/%d: invalid response", i+1, n)
		}
		seeded = response
	}
	scale := fmt.Sprintf("1s/%d_specs", n)
	for range b.opt.repeats {
		ctx, cancel := context.WithTimeout(context.Background(), b.opt.timeout)
		response, err := b.expect(ctx, http.MethodGet, path, nil, nil, http.StatusOK, nil)
		cancel()
		if err != nil {
			return err
		}
		if !bytes.Equal(response.body, seeded.body) {
			return errors.New("seeded waveform changed between identical requests")
		}
		b.add("waveform.cardinality.complete", scale, "repeat_same_spec_unverified", 1, observation{response.complete, response.bytes})
	}
	return nil
}
func (b *bench) concurrent() error {
	ctx, cancel := context.WithTimeout(context.Background(), b.opt.timeout)
	defer cancel()
	type outcome struct {
		response requestResult
		err      error
	}
	for batch := range b.opt.repeats {
		results := make(chan outcome, b.opt.concurrency)
		var wg sync.WaitGroup
		for i := range b.opt.concurrency {
			center := b.window(b.opt.repeats + 2 + batch*b.opt.concurrency + i)
			path := b.previewPath(center)
			if _, err := b.expect(ctx, "HEAD", path, nil, nil, 404, nil); err != nil {
				return err
			}
			wg.Go(func() { resp, err := b.preview(ctx, path, "miss"); results <- outcome{resp, err} })
		}
		wg.Wait()
		close(results)
		var elapsed time.Duration
		var totalBytes int64
		for result := range results {
			if result.err != nil {
				return result.err
			}
			elapsed = max(elapsed, result.response.complete)
			totalBytes += result.response.bytes
		}
		b.add("preview.concurrent.complete", "2s", "miss", b.opt.concurrency, observation{elapsed, totalBytes})
	}
	return nil
}
func (b *bench) exports() error {
	id := "p_bench_" + b.nonce
	itemID := "i_" + b.nonce + strings.Repeat("a", 24-len(b.nonce))
	projectItem := map[string]any{"id": itemID, "mediaId": b.media.ID, "segments": []any{map[string]any{"startMs": 0, "endMs": b.opt.exportSegmentMS}, map[string]any{"startMs": b.opt.exportSegmentMS + 1000, "endMs": 2*b.opt.exportSegmentMS + 1000}}}
	revision := int64(0)
	for _, strategy := range []string{"stream_copy_preferred", "precise_reencode"} {
		for range b.opt.repeats {
			projectItem["exportOptions"] = map[string]any{"mode": "merge", "selection": "segments", "cutStrategy": strategy, "container": "mkv", "destinationId": "download", "streamIndexes": []int{0, 1}}
			ctx, cancel := context.WithTimeout(context.Background(), b.opt.timeout)
			var saved struct {
				Revision int64 `json:"revision"`
			}
			_, err := b.expect(ctx, "PUT", "/api/v1/projects/"+id, map[string]any{"revision": revision, "schemaVersion": 2, "name": "media benchmark", "items": []any{projectItem}}, nil, 200, &saved)
			if err != nil {
				cancel()
				return err
			}
			if saved.Revision != revision+1 {
				cancel()
				return fmt.Errorf("project revision %d expected %d", saved.Revision, revision+1)
			}
			revision = saved.Revision
			preflight := map[string]any{"mode": "merge", "selection": "segments", "cutStrategy": strategy, "container": "mkv", "itemIds": []string{itemID}}
			var checked struct {
				Allowed   bool  `json:"allowed"`
				Selection []int `json:"selection"`
			}
			_, err = b.expect(ctx, "POST", "/api/v1/projects/"+id+"/exports/preflight", preflight, nil, 200, &checked)
			if err != nil {
				cancel()
				return err
			}
			if !checked.Allowed || len(checked.Selection) != 2 {
				cancel()
				return fmt.Errorf("preflight rejected %s: %+v", strategy, checked)
			}
			mixed := strategy == "precise_reencode"
			if err = b.exportOnce(ctx, id, itemID, strategy, mixed); err != nil {
				cancel()
				return err
			}
			cancel()
		}
	}
	return nil
}
func (b *bench) exportOnce(ctx context.Context, projectID, itemID, strategy string, mixed bool) error {
	scenario := "export." + strategy
	if mixed {
		scenario = "export.mixed." + strategy
	}
	start := time.Now()
	var submitted struct {
		Jobs []struct {
			ID string `json:"id"`
		} `json:"jobs"`
		BatchID string `json:"batchId"`
	}
	resp, err := b.expect(ctx, "POST", "/api/v1/projects/"+projectID+"/exports", map[string]any{"itemIds": []string{itemID}}, nil, 202, &submitted)
	if err != nil {
		return err
	}
	if submitted.BatchID == "" || len(submitted.Jobs) != 1 || submitted.Jobs[0].ID == "" {
		return fmt.Errorf("invalid export admission: %+v", submitted)
	}
	b.add(scenario+".admission", "2_segments", "n/a", 1, observation{resp.complete, resp.bytes})
	var mixedRun func() error
	if mixed {
		mixedRun = func() error {
			browse, browseErr := b.expect(ctx, "GET", "/api/v1/media?limit=100", nil, nil, 200, nil)
			if browseErr != nil {
				return browseErr
			}
			b.add("mixed.browse.complete", "100_items", "n/a", 1, observation{browse.complete, browse.bytes})
			previewPath := b.previewPath(b.window(0))
			previewResp, previewErr := b.preview(ctx, previewPath, "hit")
			if previewErr != nil {
				return previewErr
			}
			b.add("mixed.preview.ttfb", "2s", "hit", 1, observation{previewResp.first, 0})
			b.add("mixed.preview.complete", "2s", "hit", 1, observation{previewResp.complete, previewResp.bytes})
			return nil
		}
	}
	final, running, err := b.poll(ctx, submitted.Jobs[0].ID, mixedRun)
	if err != nil {
		return err
	}
	if mixed && running == nil {
		return errors.New("mixed workload export completed before running could be observed; increase --export-segment-ms")
	}
	if final.Result == nil || final.Result.SizeBytes <= 0 {
		return fmt.Errorf("export %s missing positive output size", submitted.Jobs[0].ID)
	}
	endToEnd := time.Since(start)
	b.add(scenario+".end_to_end", "2_segments", "n/a", 1, observation{endToEnd, final.Result.SizeBytes})
	if running != nil {
		queue := running.Sub(final.CreatedAt)
		processing := final.UpdatedAt.Sub(*running)
		if queue < 0 || processing < 0 {
			return errors.New("invalid job timestamps")
		}
		b.add(scenario+".queue_wait", "2_segments", "n/a", 1, observation{queue, 0})
		b.add(scenario+".processing", "2_segments", "n/a", 1, observation{processing, final.Result.SizeBytes})
	} else {
		fmt.Fprintf(os.Stderr, "%s job %s finished between polls; queue_wait and processing not observable\n", scenario, final.ID)
	}
	return b.verifyOutput(ctx, submitted.Jobs[0].ID, final)
}
func (b *bench) verifyOutput(ctx context.Context, id string, finished job) error {
	if finished.Result.OutputName == "" && len(finished.Result.OutputNames) != 1 {
		return errors.New("expected one export output")
	}
	output, err := b.expect(ctx, "GET", "/api/v1/jobs/"+url.PathEscape(id)+"/outputs/0", nil, nil, 200, nil)
	if err != nil {
		return err
	}
	if output.bytes <= 0 || output.bytes != finished.Result.SizeBytes {
		return fmt.Errorf("output size %d differs from job result %d", output.bytes, finished.Result.SizeBytes)
	}
	file, err := os.CreateTemp("", "videocutlist-bench-*.mkv")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(file.Name()) }()
	if _, err = file.Write(output.body); err != nil {
		_ = file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	probe, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file.Name()).Output()
	if err != nil {
		return fmt.Errorf("ffprobe export: %w", err)
	}
	var parsed struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			Type string `json:"codec_type"`
		} `json:"streams"`
	}
	if err = json.Unmarshal(probe, &parsed); err != nil {
		return err
	}
	duration, err := strconv.ParseFloat(parsed.Format.Duration, 64)
	if err != nil || duration <= 0 {
		return fmt.Errorf("invalid exported duration %q: %v", parsed.Format.Duration, err)
	}
	video, audio := false, false
	for _, stream := range parsed.Streams {
		video = video || stream.Type == "video"
		audio = audio || stream.Type == "audio"
	}
	if !video || !audio {
		return errors.New("export missing video or audio stream")
	}
	return nil
}
