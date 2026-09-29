// Command api seeds and measures the production media catalog without probing synthetic files.
package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"videocutlist/internal/db"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/library/media/probe"
)

const pageLimit = 10

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "api benchmark:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 || args[0] == "-help" || args[0] == "--help" || args[0] == "help" {
		usage()
		return nil
	}
	switch args[0] {
	case "seed":
		flags := flag.NewFlagSet("seed", flag.ContinueOnError)
		flags.SetOutput(os.Stderr)
		dbPath := flags.String("db", "", "SQLite database path (use a disposable database outside the repository)")
		alias := flags.String("alias", "bench", "configured empty media root alias; MUST seed after the initial server scan completes")
		count := flags.Int("count", 100, "number of synthetic media records (e.g. 100, 1000, 5000)")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 || *dbPath == "" || *alias == "" || *count < 100 {
			return errors.New("seed requires --db, --alias, and --count >= 100 with no positional arguments")
		}
		return seed(*dbPath, *alias, *count)
	case "run":
		flags := flag.NewFlagSet("run", flag.ContinueOnError)
		flags.SetOutput(os.Stderr)
		base := flags.String("base", os.Getenv("VIDEOCUTLIST_BENCH_BASE"), "running production server URL (or VIDEOCUTLIST_BENCH_BASE)")
		token := flags.String("token", os.Getenv("VIDEOCUTLIST_BENCH_TOKEN"), "bearer token (or VIDEOCUTLIST_BENCH_TOKEN; required if server uses bearer auth)")
		alias := flags.String("alias", "bench", "alias used by seed")
		scale := flags.Int("scale", 100, "number of seeded media records, matching seed --count")
		samples := flags.Int("samples", 30, "completed requests per scenario and concurrency level")
		parallel := flags.Int("concurrency", 8, "second concurrency level (first level is always 1)")
		dbPath := flags.String("db", "", "optional local SQLite path to verify the exact seeded alias count before measuring")
		if err := flags.Parse(args[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 || *base == "" || *alias == "" || *scale < 100 || *samples < 1 || *parallel < 2 {
			return errors.New("run requires --base, --scale >= 100, --samples >= 1, --concurrency >= 2, and no positional arguments")
		}
		return benchmark(*base, *token, *alias, *scale, *samples, *parallel, *dbPath)
	default:
		usage()
		return fmt.Errorf("unknown subcommand %q", args[0])
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `Usage: go run ./test/performance/api seed --db PATH [--alias bench] [--count 100]
       go run ./test/performance/api run --base http://127.0.0.1:PORT [--token TOKEN] [--db PATH] [--alias bench] [--scale 100] [--samples 30] [--concurrency 8]

Start a real production server with an empty configured root named bench and wait for its
initial media scan to finish. Then seed its disposable SQLite database while the server
is running. Run this command before another media refresh or restart: a scan of the
empty bench directory will mark synthetic records unavailable. Seeded rows are catalog
metadata only, not files: benchmark only GET /api/v1/media and /api/v1/media/tree.
To compare 100/1000/5000 rows, repeat seed (same alias) and run for each scale.
Set VIDEOCUTLIST_BENCH_BASE / VIDEOCUTLIST_BENCH_TOKEN instead of --base / --token.
Only measured HTTP requests appear on stdout, as CSV; diagnostics go to stderr.
The warm label denotes requests after a validated warm-up, not an HTTP cache hit.`)
}

// The first fifth supplies root-level pagination; the next fifth supplies deep
// pagination; the remainder spreads records across sibling folders.
func relativePath(i, count int) string {
	portion := count / 5
	switch {
	case i < portion:
		return fmt.Sprintf("%06d.mp4", i)
	case i < 2*portion:
		return fmt.Sprintf("collection/deep/%06d.mp4", i)
	default:
		return fmt.Sprintf("collection/set-%02d/%06d.mp4", i%8, i)
	}
}

func records(alias string, count int) []index.Record {
	result := make([]index.Record, 0, count)
	metadata := probe.Metadata{
		DurationMS: 12_000, Container: "mp4", Video: &probe.Video{Codec: "h264", Width: 1280, Height: 720, AvgFrameRate: "25/1"},
		VideoStreams: 1, Streams: []probe.Stream{{Index: 0, Type: "video", Codec: "h264", Width: 1280, Height: 720, AvgFrameRate: "25/1"}},
	}
	for i := range count {
		relative := relativePath(i, count)
		result = append(result, index.Record{
			Media:     index.Media{ID: index.MediaID(alias, relative), Name: path.Base(relative), SizeBytes: 1_000_000 + int64(i), MtimeNS: 1_700_000_000_000_000_000, Metadata: metadata},
			RootAlias: alias, RelativePath: relative,
		})
	}
	return result
}

func seed(dbPath, alias string, count int) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	database, err := store.OpenDatabase(ctx, dbPath)
	if err != nil {
		return fmt.Errorf("open disposable database: %w", err)
	}
	defer func() { _ = database.Close() }()
	catalog, err := store.NewMediaStore(database)
	if err != nil {
		return err
	}
	if err := catalog.Sync(ctx, alias, records(alias, count)); err != nil {
		return fmt.Errorf("sync %d records: %w", count, err)
	}
	fmt.Fprintf(os.Stderr, "seeded %d catalog records under alias %q; do not refresh or restart server before run\n", count, alias)
	return nil
}

type page struct {
	Folders []struct {
		ID    string `json:"id"`
		Label string `json:"label"`
	} `json:"folders"`
	Items []struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		DurationMS int64  `json:"durationMs"`
		Container  string `json:"container"`
	} `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

type scenario struct {
	name       string
	url        string
	folderID   string
	candidates map[string]string // seeded ID -> expected name in this page
	folders    map[string]string // expected immediate child folder ID -> label
	exactIDs   []string          // deep folder has no other configured media
}

func makeScenarios(base, alias string, count int) []scenario {
	all, root, deep := make([]index.Record, 0, count), make([]index.Record, 0, count/5), make([]index.Record, 0, count/5)
	for _, record := range records(alias, count) {
		all = append(all, record)
		switch {
		case !strings.Contains(record.RelativePath, "/"):
			root = append(root, record)
		case strings.HasPrefix(record.RelativePath, "collection/deep/"):
			deep = append(deep, record)
		}
	}
	byID := func(records []index.Record) []index.Record {
		slices.SortFunc(records, func(a, b index.Record) int { return strings.Compare(a.ID, b.ID) })
		return records
	}
	all, root, deep = byID(all), byID(root), byID(deep)
	build := func(name, endpoint, folder string, group []index.Record, folderNames map[string]string, late bool) scenario {
		query := url.Values{"limit": {fmt.Sprint(pageLimit)}}
		if folder != "" {
			query.Set("folderId", folder)
		}
		start := 0
		if late {
			start = len(group) - pageLimit
			query.Set("cursor", group[start-1].ID)
		}
		known := make(map[string]string, len(group))
		for _, record := range group {
			known[record.ID] = record.Name
		}
		spec := scenario{name: name, url: base + endpoint + "?" + query.Encode(), folderID: folder, candidates: known, folders: folderNames}
		if folder != "" {
			spec.exactIDs = make([]string, pageLimit)
			for i, record := range group[start : start+pageLimit] {
				spec.exactIDs[i] = record.ID
			}
		}
		return spec
	}
	return []scenario{
		build("media_list_first", "/api/v1/media", "", all, nil, false),
		build("media_list_late", "/api/v1/media", "", all, nil, true),
		build("media_tree_root_first", "/api/v1/media/tree", "", root, map[string]string{index.FolderID(alias, "collection"): "collection"}, false),
		build("media_tree_root_late", "/api/v1/media/tree", "", root, map[string]string{index.FolderID(alias, "collection"): "collection"}, true),
		build("media_tree_deep_first", "/api/v1/media/tree", index.FolderID(alias, "collection/deep"), deep, nil, false),
		build("media_tree_deep_late", "/api/v1/media/tree", index.FolderID(alias, "collection/deep"), deep, nil, true),
	}
}

func verifySeededCount(dbPath, alias string, count int) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	database, err := store.OpenDatabase(ctx, dbPath)
	if err != nil {
		return err
	}
	defer func() { _ = database.Close() }()
	var got int
	if err := database.QueryRowContext(ctx, "SELECT COUNT(*) FROM media WHERE root_alias = ? AND available = 1", alias).Scan(&got); err != nil {
		return err
	}
	if got != count {
		return fmt.Errorf("seeded alias %q has %d available rows; expected %d (initial scan/refresh may have removed rows)", alias, got, count)
	}
	return nil
}

func benchmark(base, token, alias string, count, samples, parallel int, dbPath string) error {
	parsed, err := url.Parse(base)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" && parsed.Path != "/" {
		return errors.New("--base must be a plain http(s) origin (no path, query or fragment)")
	}
	if dbPath != "" {
		if err := verifySeededCount(dbPath, alias, count); err != nil {
			return fmt.Errorf("verify dataset: %w", err)
		}
	}
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{MaxIdleConns: parallel + 2, MaxIdleConnsPerHost: parallel + 2}}
	defer client.CloseIdleConnections()
	writer := csv.NewWriter(os.Stdout)
	if err := writer.Write([]string{"scenario", "scale", "cache", "concurrency", "samples", "p50_ms", "p95_ms", "p99_ms", "throughput_per_s", "bytes_per_s", "errors"}); err != nil {
		return err
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return err
	}
	for _, spec := range makeScenarios(strings.TrimSuffix(base, "/"), alias, count) {
		if _, _, err := request(client, token, spec); err != nil {
			return fmt.Errorf("preflight %s: %w", spec.name, err)
		}
		for _, concurrency := range []int{1, parallel} {
			if err := measure(client, token, spec, count, samples, concurrency, writer); err != nil {
				return err
			}
		}
	}
	return nil
}

// request times through complete body reception, before JSON validation. This
// separates client-visible transfer latency from the benchmark's own checks.
func request(client *http.Client, token string, spec scenario) (time.Duration, int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, spec.url, nil)
	if err != nil {
		return 0, 0, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return time.Since(start), 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	// Bound memory even if the server returns an unexpected or unbounded body.
	body, err := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
	elapsed := time.Since(start)
	if err != nil {
		return elapsed, int64(len(body)), err
	}
	if len(body) > 2<<20 {
		return elapsed, int64(len(body)), errors.New("response exceeds 2 MiB limit")
	}
	if resp.StatusCode != http.StatusOK {
		return elapsed, int64(len(body)), fmt.Errorf("HTTP %d: %.240s", resp.StatusCode, body)
	}
	var result page
	if err := json.Unmarshal(body, &result); err != nil {
		return elapsed, int64(len(body)), fmt.Errorf("decode JSON: %w", err)
	}
	if len(result.Items) == 0 || len(result.Items) > pageLimit {
		return elapsed, int64(len(body)), fmt.Errorf("expected 1..%d items, got %d", pageLimit, len(result.Items))
	}
	seen := 0
	for i, item := range result.Items {
		if i > 0 && result.Items[i-1].ID >= item.ID {
			return elapsed, int64(len(body)), errors.New("media items are not sorted by ID")
		}
		if expected, ok := spec.candidates[item.ID]; ok {
			if item.Name != expected || item.DurationMS != 12_000 || item.Container != "mp4" {
				return elapsed, int64(len(body)), fmt.Errorf("incorrect seeded media %q", item.ID)
			}
			seen++
		} else if spec.folderID != "" {
			return elapsed, int64(len(body)), fmt.Errorf("unexpected folder media %q", item.ID)
		}
	}
	if seen == 0 {
		return elapsed, int64(len(body)), errors.New("page has no seeded media; check server scan and alias")
	}
	if spec.exactIDs != nil {
		if len(result.Items) != len(spec.exactIDs) {
			return elapsed, int64(len(body)), fmt.Errorf("expected %d deep folder items, got %d", len(spec.exactIDs), len(result.Items))
		}
		for i, expected := range spec.exactIDs {
			if result.Items[i].ID != expected {
				return elapsed, int64(len(body)), fmt.Errorf("deep folder item %d: got %q, want %q", i, result.Items[i].ID, expected)
			}
		}
	}
	for id, label := range spec.folders {
		found := false
		for _, folder := range result.Folders {
			if folder.ID == id && folder.Label == label {
				found = true
			}
		}
		if !found {
			return elapsed, int64(len(body)), fmt.Errorf("expected folder %q missing", label)
		}
	}
	return elapsed, int64(len(body)), nil
}

func measure(client *http.Client, token string, spec scenario, scale, samples, concurrency int, writer *csv.Writer) error {
	latencies := make([]time.Duration, samples)
	var next, failures atomic.Int64
	var byteCount atomic.Int64
	var firstError error
	var errorMu sync.Mutex
	var workers sync.WaitGroup
	start := time.Now()
	for range min(concurrency, samples) {
		workers.Go(func() {
			for {
				i := int(next.Add(1)) - 1
				if i >= samples {
					return
				}
				latency, bytes, err := request(client, token, spec)
				latencies[i] = latency
				byteCount.Add(bytes)
				if err != nil {
					failures.Add(1)
					errorMu.Lock()
					if firstError == nil {
						firstError = err
					}
					errorMu.Unlock()
				}
			}
		})
	}
	workers.Wait()
	wall := time.Since(start).Seconds()
	slices.Sort(latencies)
	percentile := func(p float64) string {
		idx := max(0, int(math.Ceil(float64(samples)*p))-1)
		return fmt.Sprintf("%.3f", float64(latencies[idx])/float64(time.Millisecond))
	}
	row := []string{spec.name, fmt.Sprint(scale), "warm", fmt.Sprint(concurrency), fmt.Sprint(samples), percentile(.50), percentile(.95), percentile(.99), fmt.Sprintf("%.3f", float64(samples)/wall), fmt.Sprintf("%.3f", float64(byteCount.Load())/wall), fmt.Sprint(failures.Load())}
	if err := writer.Write(row); err != nil {
		return err
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return err
	}
	if firstError != nil {
		return fmt.Errorf("%s concurrency=%d: %d/%d failed: %w", spec.name, concurrency, failures.Load(), samples, firstError)
	}
	return nil
}
