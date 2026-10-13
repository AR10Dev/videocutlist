package mcp_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	dbstore "videocutlist/internal/db"
	jobstore "videocutlist/internal/jobs"
	jobmodel "videocutlist/internal/jobs/model"
	"videocutlist/internal/mcp"
)

const authenticationPressureCompletions = 300

// BenchmarkTransportAuthenticationPressureConcurrentJobCompletion compares
// durable completion alone with authenticated and unknown-ID MCP requests on
// the same one-connection SQLite database. Run with -benchtime=1x for bounded,
// reproducible samples and compare completion percentile metrics by subtest.
func BenchmarkTransportAuthenticationPressureConcurrentJobCompletion(b *testing.B) {
	for _, scenario := range []struct {
		name      string
		tokenKind string
	}{
		{name: "completion_only"},
		{name: "valid_token", tokenKind: "valid"},
		{name: "unknown_identifier", tokenKind: "unknown"},
	} {
		b.Run(scenario.name, func(b *testing.B) {
			var completionLatencies []int64
			var authRequests, authOK, authUnauthorized, authRateLimited, authUnexpected uint64
			for b.Loop() {
				latencies, attempts, ok, unauthorized, rateLimited, unexpected := runAuthenticationPressureSample(b, scenario.tokenKind)
				completionLatencies = append(completionLatencies, latencies...)
				authRequests += attempts
				authOK += ok
				authUnauthorized += unauthorized
				authRateLimited += rateLimited
				authUnexpected += unexpected
			}
			slices.Sort(completionLatencies)
			b.ReportMetric(float64(completionLatencies[(len(completionLatencies)-1)/2])/1e3, "completion-p50-us")
			p95Index := (len(completionLatencies)*95+99)/100 - 1
			b.ReportMetric(float64(completionLatencies[p95Index])/1e3, "completion-p95-us")
			b.ReportMetric(float64(authRequests)/float64(b.N), "auth-requests/op")
			b.ReportMetric(float64(authOK)/float64(b.N), "auth-http-200/op")
			b.ReportMetric(float64(authUnauthorized)/float64(b.N), "auth-http-401/op")
			b.ReportMetric(float64(authRateLimited)/float64(b.N), "auth-http-429/op")
			b.ReportMetric(float64(authUnexpected)/float64(b.N), "auth-unexpected/op")
		})
	}
}

func runAuthenticationPressureSample(b *testing.B, tokenKind string) ([]int64, uint64, uint64, uint64, uint64, uint64) {
	b.Helper()
	ctx := context.Background()
	database, err := dbstore.OpenDatabase(ctx, b.TempDir()+"/pressure.db")
	if err != nil {
		b.Fatal(err)
	}
	defer func() {
		if err := database.Close(); err != nil {
			b.Error(err)
		}
	}()

	mcpStorage, err := dbstore.NewMCPStorage(database)
	if err != nil {
		b.Fatal(err)
	}
	credentials, err := mcp.NewCredentialStore(mcpStorage)
	if err != nil {
		b.Fatal(err)
	}
	expires := time.Now().Add(time.Hour)
	created, err := credentials.Create(ctx, mcp.CredentialInput{
		Name: "pressure test", Permissions: []mcp.Permission{mcp.PermissionMediaRead},
		MediaScope: mcp.MediaScope{Kind: mcp.MediaScopeAll}, ProjectScope: mcp.ProjectScope{Kind: mcp.ProjectScopeAll}, ExpiresAt: &expires,
	})
	if err != nil {
		b.Fatal(err)
	}

	var token string
	switch tokenKind {
	case "valid":
		token = created.Secret
	case "unknown":
		_, encodedSecret, ok := strings.Cut(created.Secret, ".")
		if !ok {
			b.Fatal("created credential token has no secret separator")
		}
		token = "vcl_t_" + strings.Repeat("A", 16) + "." + encodedSecret
	}

	transport, err := mcp.NewTransport(mcp.TransportConfig{
		Enabled: true, Credentials: credentials,
	})
	if err != nil {
		b.Fatal(err)
	}
	var sessionID string
	if tokenKind == "valid" {
		initialize := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8787/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"pressure","version":"1"}}}`))
		initialize.RemoteAddr = "127.0.0.1:1234"
		initialize.Header.Set("Accept", "application/json, text/event-stream")
		initialize.Header.Set("Content-Type", "application/json")
		initialize.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		transport.ServeHTTP(response, initialize)
		if response.Code != http.StatusOK || response.Header().Get("Mcp-Session-Id") == "" {
			b.Fatalf("initialize MCP session: status=%d body=%s", response.Code, response.Body.String())
		}
		sessionID = response.Header().Get("Mcp-Session-Id")
	}

	storage, err := dbstore.NewJobStorage(database)
	if err != nil {
		b.Fatal(err)
	}
	jobs, err := jobstore.NewJobsStore(storage)
	if err != nil {
		b.Fatal(err)
	}
	jobIDs := make([]string, authenticationPressureCompletions)
	for index := range jobIDs {
		id := fmt.Sprintf("j_%012d", index)
		batchID := fmt.Sprintf("b_%012d", index)
		if _, err := jobs.Create(ctx, jobmodel.Job{ID: id, BatchID: batchID, Kind: jobmodel.JobScan, RequestJSON: `{"root":"fixture"}`}); err != nil {
			b.Fatal(err)
		}
		if _, err := jobs.Start(ctx, id); err != nil {
			b.Fatal(err)
		}
		jobIDs[index] = id
	}

	var requests, successful, unauthorized, rateLimited, unexpected atomic.Uint64
	const authenticationWorkers = 4
	start := make(chan struct{})
	ready := make(chan struct{}, authenticationWorkers)
	firstRequestDone := make(chan struct{}, authenticationWorkers)
	stop := make(chan struct{})
	var workers sync.WaitGroup
	if tokenKind != "" {
		for range authenticationWorkers {
			workers.Go(func() {
				ready <- struct{}{}
				<-start
				firstRequest := true
				for {
					select {
					case <-stop:
						return
					default:
					}
					request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8787/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"ping"}`))
					request.RemoteAddr = "127.0.0.1:1234"
					request.Header.Set("Accept", "application/json, text/event-stream")
					request.Header.Set("Content-Type", "application/json")
					request.Header.Set("Authorization", "Bearer "+token)
					if sessionID != "" {
						request.Header.Set("Mcp-Session-Id", sessionID)
						request.Header.Set("MCP-Protocol-Version", mcp.ProtocolVersion)
					}
					response := httptest.NewRecorder()
					transport.ServeHTTP(response, request)
					if firstRequest {
						firstRequestDone <- struct{}{}
						firstRequest = false
					}
					requests.Add(1)
					switch response.Code {
					case http.StatusOK:
						successful.Add(1)
					case http.StatusUnauthorized:
						unauthorized.Add(1)
					case http.StatusTooManyRequests:
						rateLimited.Add(1)
					default:
						unexpected.Add(1)
					}
				}
			})
		}
		for range authenticationWorkers {
			<-ready
		}
		close(start)
		for range authenticationWorkers {
			<-firstRequestDone
		}
	}

	latencies := make([]int64, 0, len(jobIDs))
	for _, id := range jobIDs {
		started := time.Now()
		if _, err := jobs.Succeed(ctx, id, `{}`); err != nil {
			b.Fatal(err)
		}
		latencies = append(latencies, time.Since(started).Nanoseconds())
	}
	if tokenKind != "" {
		close(stop)
		workers.Wait()
	}
	if tokenKind == "unknown" && (requests.Load() == 0 || unauthorized.Load() == 0 || rateLimited.Load() == 0 || unexpected.Load() != 0) {
		b.Fatalf("unknown-token workload requests=%d unauthorized=%d rate-limited=%d unexpected=%d", requests.Load(), unauthorized.Load(), rateLimited.Load(), unexpected.Load())
	}
	if tokenKind == "valid" && (requests.Load() == 0 || successful.Load() == 0 || rateLimited.Load() == 0 || unexpected.Load() != 0) {
		b.Fatalf("valid-token workload requests=%d successful=%d rate-limited=%d unexpected=%d", requests.Load(), successful.Load(), rateLimited.Load(), unexpected.Load())
	}

	shutdownCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if err := transport.Shutdown(shutdownCtx); err != nil {
		b.Fatal(err)
	}
	return latencies, requests.Load(), successful.Load(), unauthorized.Load(), rateLimited.Load(), unexpected.Load()
}
