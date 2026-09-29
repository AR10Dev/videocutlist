package store_test

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"videocutlist/internal/db"
	"videocutlist/internal/library/media/index"
)

func TestMediaBrowseUsesParentIndexes(t *testing.T) {
	database, err := store.OpenDatabase(t.Context(), filepath.Join(t.TempDir(), "media.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	for _, query := range []struct {
		name, statement, index string
		args                   []any
	}{
		{
			name:      "folders",
			statement: `EXPLAIN QUERY PLAN SELECT id, label FROM media_folders WHERE available = 1 AND parent_folder_id = ? ORDER BY id`,
			index:     "USING INDEX media_folders_available_parent_id",
			args:      []any{""},
		},
		{
			name:      "items",
			statement: `EXPLAIN QUERY PLAN SELECT id, relative_path, size_bytes, mtime_ns, metadata_json FROM media WHERE available = 1 AND parent_folder_id = ? AND id > ? ORDER BY id LIMIT ?`,
			index:     "USING INDEX media_available_parent_id",
			args:      []any{"", "", 6},
		},
	} {
		t.Run(query.name, func(t *testing.T) {
			rows, err := database.QueryContext(t.Context(), query.statement, query.args...)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := rows.Close(); err != nil {
					t.Error(err)
				}
			}()
			var plan []string
			for rows.Next() {
				var id, parent, unused int
				var detail string
				if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
					t.Fatal(err)
				}
				plan = append(plan, detail)
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			if len(plan) != 1 || !strings.Contains(plan[0], query.index) {
				t.Fatalf("expected %s, query plan: %v", query.index, plan)
			}
			t.Logf("query plan: %s", plan[0])
		})
	}
}

func BenchmarkMediaBrowse(b *testing.B) {
	for _, count := range []int{100, 1000, 5000, 10000} {
		b.Run(fmt.Sprintf("rows=%d", count), func(b *testing.B) {
			database, err := store.OpenDatabase(b.Context(), filepath.Join(b.TempDir(), "media.db"))
			if err != nil {
				b.Fatal(err)
			}
			b.Cleanup(func() { _ = database.Close() })
			media, err := store.NewMediaStore(database)
			if err != nil {
				b.Fatal(err)
			}
			records := benchmarkCatalogRecords(count)
			if err := media.Sync(b.Context(), "bench", records); err != nil {
				b.Fatal(err)
			}
			for _, folder := range []string{"", index.FolderID("bench", "sibling/001")} {
				name := "root"
				if folder != "" {
					name = "deep"
				}
				b.Run(name, func(b *testing.B) {
					b.ReportAllocs()
					for b.Loop() {
						_, items, _, err := media.Browse(b.Context(), folder, "", 5)
						if err != nil {
							b.Fatal(err)
						}
						if len(items) != 5 {
							b.Fatalf("browse returned %d items, want 5", len(items))
						}
					}
				})
			}
		})
	}
}

// BenchmarkMediaBrowseWaitStats compares one and two simultaneous callers of
// the single-connection SQLite pool. Wait metrics are deltas per browse request.
func BenchmarkMediaBrowseWaitStats(b *testing.B) {
	database, err := store.OpenDatabase(b.Context(), filepath.Join(b.TempDir(), "media.db"))
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = database.Close() })
	media, err := store.NewMediaStore(database)
	if err != nil {
		b.Fatal(err)
	}
	if err := media.Sync(b.Context(), "bench", benchmarkCatalogRecords(5000)); err != nil {
		b.Fatal(err)
	}
	folder := index.FolderID("bench", "sibling/001")
	for _, clients := range []int{1, 2} {
		b.Run(fmt.Sprintf("rows=5000/deep/clients=%d", clients), func(b *testing.B) {
			ctx := b.Context()
			before := database.Stats()
			var next atomic.Uint64
			var workers sync.WaitGroup
			failures := make(chan error, clients)
			b.ResetTimer()
			for range clients {
				workers.Go(func() {
					for {
						if next.Add(1) > uint64(b.N) {
							return
						}
						_, items, _, err := media.Browse(ctx, folder, "", 5)
						if err == nil && len(items) != 5 {
							err = fmt.Errorf("browse returned %d items, want 5", len(items))
						}
						if err != nil {
							failures <- err
							return
						}
					}
				})
			}
			workers.Wait()
			b.StopTimer()
			close(failures)
			for err := range failures {
				b.Fatal(err)
			}
			after := database.Stats()
			b.ReportMetric(float64(after.WaitCount-before.WaitCount)/float64(b.N), "waits/op")
			b.ReportMetric(float64((after.WaitDuration-before.WaitDuration).Nanoseconds())/float64(b.N), "wait_ns/op")
		})
	}
}
func BenchmarkMediaSyncUnchanged(b *testing.B) {
	for _, count := range []int{100, 1000, 5000, 10000} {
		b.Run(fmt.Sprintf("rows=%d", count), func(b *testing.B) {
			database, err := store.OpenDatabase(b.Context(), filepath.Join(b.TempDir(), "media.db"))
			if err != nil {
				b.Fatal(err)
			}
			b.Cleanup(func() { _ = database.Close() })
			media, err := store.NewMediaStore(database)
			if err != nil {
				b.Fatal(err)
			}
			records := benchmarkCatalogRecords(count)
			if err := media.Sync(b.Context(), "bench", records); err != nil {
				b.Fatal(err)
			}
			b.ReportAllocs()
			for b.Loop() {
				if err := media.Sync(b.Context(), "bench", records); err != nil {
					b.Fatal(err)
				}
			}
			b.ReportMetric(float64(count)*float64(b.N)/b.Elapsed().Seconds(), "items/s")
		})
	}
}

func benchmarkCatalogRecords(count int) []index.Record {
	records := make([]index.Record, count)
	for i := range records {
		relative := fmt.Sprintf("sibling/%03d/clip-%06d.mp4", i%16, i)
		if i%4 == 0 {
			relative = fmt.Sprintf("clip-%06d.mp4", i)
		}
		records[i] = index.Record{
			Media:        index.Media{ID: index.MediaID("bench", relative), SizeBytes: 1024, MtimeNS: 1},
			RootAlias:    "bench",
			RelativePath: relative,
		}
	}
	return records
}
