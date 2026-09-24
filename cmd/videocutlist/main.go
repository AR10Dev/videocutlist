package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"maps"
	"net"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"syscall"
	"time"

	"videocutlist/internal/db"
	detection "videocutlist/internal/detection"
	exporter "videocutlist/internal/export"
	"videocutlist/internal/httpapi"
	jobqueue "videocutlist/internal/jobs"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/library/media/probe"
	"videocutlist/internal/mcp"
	"videocutlist/internal/preview/cache"
	"videocutlist/internal/preview/ffmpeg"
	"videocutlist/internal/projects"
	"videocutlist/internal/runtime"
	"videocutlist/internal/settings"
	"videocutlist/internal/web/assets"
	"videocutlist/internal/web/webassets"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) (runErr error) {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	logger := log.New(os.Stdout, "", 0)
	db, err := store.OpenDatabase(ctx, cfg.DatabasePath)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := db.Close(); closeErr != nil {
			runErr = errors.Join(runErr, fmt.Errorf("close database: %w", closeErr))
		}
	}()
	mcpCredentials, err := mcp.NewCredentialStore(db)
	if err != nil {
		return err
	}
	runtimeSettingsStore, err := store.NewRuntimeSettingsStore(db)
	if err != nil {
		return err
	}
	effectiveSettings, err := runtimeSettingsStore.Seed(ctx, cfg.RuntimeSettings())
	if err != nil {
		return err
	}
	if err := cfg.ApplyRuntimeSettings(effectiveSettings.Settings); err != nil {
		return fmt.Errorf("load runtime settings: %w", err)
	}
	runtimeState := store.NewRuntimeSettingsState(effectiveSettings.Settings)
	projectStore, _ := store.NewProjectStore(db)
	unifiedJobs, err := jobqueue.NewJobsStore(db)
	if err != nil {
		return err
	}
	mediaStore, _ := store.NewMediaStore(db)
	roots := make([]index.Root, 0, len(cfg.MediaRoots))
	aliases := slices.Sorted(maps.Keys(cfg.MediaRoots))
	for _, alias := range aliases {
		roots = append(roots, index.Root{Alias: alias, Path: cfg.MediaRoots[alias]})
	}
	scanner, err := index.NewScannerWithLimits(roots, probe.Client{Path: cfg.FFprobePath}, index.ScanLimits{MaxFiles: cfg.MediaMaxFiles, MaxDepth: cfg.MediaMaxDepth})
	if err != nil {
		return err
	}
	previewCacheBytes, timelineCacheBytes := runtime.CacheBudgets(cfg.CacheMaxBytes)
	cacheStore, err := cache.New(cfg.CacheDir, previewCacheBytes)
	if err != nil {
		return err
	}
	if err := cacheStore.CleanupPartials(); err != nil {
		return err
	}
	limiter, err := projects.NewPreviewLimits(cfg.PreviewGlobalLimit)
	if err != nil {
		return err
	}
	validator := cache.ValidatorFunc(func(ctx context.Context, path string) error {
		return ffmpeg.ValidateFile(ctx, cfg.FFprobePath, path)
	})
	mediaCatalog := runtime.MediaCatalog{Scanner: scanner, Store: mediaStore}
	mediaService := &projects.MediaUseCase{Catalog: mediaCatalog, Configured: len(cfg.MediaRoots) > 0}
	detectionService := projects.NewDetectionUseCase(&detection.Service{Scanner: scanner, Catalog: mediaStore, FFmpegPath: cfg.FFmpegPath, Capacity: limiter})
	detectionService.Catalog = mediaCatalog
	previewRunner := runtime.PreviewRunner{Scanner: scanner, Media: mediaStore, FFmpeg: ffmpeg.Runner{Path: cfg.FFmpegPath}}
	previewManager, err := projects.NewPreviewManager(runtime.PreviewCache{Store: cacheStore}, previewRunner, projects.Validator(validator), limiter)
	if err != nil {
		return err
	}
	previewService := projects.PreviewUseCase{Catalog: mediaCatalog, Manager: previewManager}
	assetService := &assets.Service{Scanner: scanner, Media: mediaStore, FFmpegPath: cfg.FFmpegPath, CacheDir: cfg.CacheDir, MaxBytes: timelineCacheBytes, Capacity: limiter}
	projectService := projects.ProjectUseCase{Repository: runtime.ProjectRepository{Store: projectStore}, Media: mediaCatalog}
	artifacts := exporter.NewArtifactStore()
	if err := artifacts.Reconcile(ctx, unifiedJobs, cfg.FFprobePath, cfg.Destinations); err != nil {
		return err
	}
	if _, err := unifiedJobs.Recover(ctx); err != nil {
		return err
	}
	artifacts.Cleanup(time.Now().UTC())
	go func() {
		ticks := time.Tick(15 * time.Minute)
		for {
			select {
			case now := <-ticks:
				artifacts.Cleanup(now.UTC())
			case <-ctx.Done():
				return
			}
		}
	}()
	exportExecutor := runtime.NewExportExecutor(unifiedJobs, scanner, mediaStore, exporter.Service{
		FFmpegPath: cfg.FFmpegPath, FFprobePath: cfg.FFprobePath, OutputDir: cfg.ExportDir, Destinations: cfg.Destinations, Artifacts: artifacts, Capacity: limiter,
	})
	exportExecutor.Settings = runtimeState
	batchExports := projects.BatchExportUseCase{Projects: runtime.ProjectRepository{Store: projectStore}, Media: mediaCatalog, Jobs: unifiedJobs, Settings: runtimeState, RemoveArtifacts: artifacts.Remove}
	queuedJobs := runtime.QueuedJobs{Jobs: unifiedJobs, Exports: &batchExports, Media: mediaService, Detection: detectionService, Catalog: mediaCatalog}
	scheduler, err := jobqueue.NewScheduler(unifiedJobs, jobqueue.SchedulerConfig{QueueCapacity: cfg.ExportLimit * 4, WorkerLimit: cfg.ExportLimit, Logger: logger}, queuedJobs.Run)
	if err != nil {
		return err
	}
	batchExports.Scheduler = scheduler
	mediaService.Scheduler, mediaService.UnifiedJobs = scheduler, unifiedJobs
	detectionService.Scheduler, detectionService.UnifiedJobs = scheduler, unifiedJobs
	batchExports.RunSnapshot = func(ctx context.Context, jobID string, snapshot projects.ExportSnapshot) (string, error) {
		return exportExecutor.ExecuteBatchSnapshot(ctx, jobID, snapshot)
	}
	scheduler.Start()
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := scheduler.Shutdown(cleanup); err != nil {
			runErr = errors.Join(runErr, fmt.Errorf("shutdown jobs: %w", err))
		}
	}()
	if mediaService.Configured {
		if _, err := mediaService.StartImport(ctx); err != nil && !errors.Is(err, jobqueue.ErrQueueFull) {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("start initial media scan: %w", err)
		}
	}
	jobService := projects.JobUseCase{Jobs: unifiedJobs}
	authenticator, err := httpapi.NewAuthenticator(httpapi.AuthConfig{
		Mode: cfg.AuthMode, BearerToken: cfg.BearerToken, ListenAddress: cfg.ListenAddress,
	})
	if err != nil {
		return err
	}
	settingsApplier := runtime.RuntimeSettingsApplier{State: runtimeState, Scanner: scanner, PreviewLimits: limiter, PreviewCache: cacheStore, Assets: assetService, Scheduler: scheduler}
	proposalService, err := mcp.NewProposalService(db, mcpCredentials, projectService, mediaCatalog, exportExecutor, scheduler)
	if err != nil {
		return err
	}
	apiServer, err := httpapi.New(httpapi.Config{
		Authenticator: authenticator, Media: mediaService, Preview: previewService, Assets: assetService,
		Projects: projectService, BatchExports: batchExports, Preflight: exportExecutor, Jobs: jobService, Detection: detectionService, Download: exportExecutor, MediaImport: mediaService,
		Settings: config.NewRuntimeService(runtimeSettingsStore, runtimeState, settingsApplier.Apply), RuntimeSettings: runtimeState, MCPCredentials: mcpCredentials, ExportProposals: proposalService,
		Destinations: destinationMetadata(cfg.Destinations),
		Ready:        db.PingContext, Logger: logger, Metrics: httpapi.NewMetrics(),
		BeforeMS: int64(cfg.PreviewBeforeMS), AfterMS: int64(cfg.PreviewAfterMS),
		MaxPreviewMS: int64(cfg.PreviewMaxMS), GridMS: int64(cfg.PreviewGridMS), ListenerAddress: cfg.ListenAddress, AllowedOrigins: cfg.AllowedOrigins, RequireAutomationAuth: cfg.AuthMode != "none",
	})
	if err != nil {
		return err
	}

	mcpTools := append(mcp.MediaTools(mediaService), mcp.ExportTools(proposalService, scheduler, exportExecutor)...)
	mcpTools = append(mcpTools, mcp.ProjectTools(projectService, mediaService, mcpCredentials)...)
	mcpTools = append(mcpTools, mcp.PreviewDetectionTools(mediaService, previewService, detectionService, projectService)...)
	mcpTransportConfig := mcp.TransportConfig{
		Enabled: cfg.MCPEnabled, EnabledFunc: func() bool { return runtimeState.Snapshot().MCPEnabled }, Credentials: mcpCredentials, Tools: mcpTools, AllowedOrigins: cfg.AllowedOrigins,
		MaxConcurrentRequests: cfg.PreviewGlobalLimit,
		RequestInfo: func(request *http.Request) mcp.RequestInfo {
			forwarded := httpapi.GetForwardedInfo(request.Context())
			return mcp.RequestInfo{ClientIP: forwarded.ClientIP, Host: forwarded.Host, Proto: forwarded.Proto}
		},
	}
	mcpTransport, err := mcp.NewTransport(mcpTransportConfig)
	if err != nil {
		return err
	}
	mcpDownloads, err := mcp.ExportDownloadHandler(mcpTransportConfig, proposalService, scheduler, exportExecutor)
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.Handle("/mcp/download/", httpapi.MCPCORS(cfg.AllowedOrigins, mcpDownloads))
	mux.Handle("/mcp", httpapi.MCPCORS(cfg.AllowedOrigins, mcpTransport))
	mux.Handle("/api/", apiServer)
	mux.Handle("/metrics", apiServer)
	mux.Handle("/", httpapi.CORS(cfg.AllowedOrigins, webassets.DefaultHandler()))
	proxied, err := httpapi.TrustedProxy(cfg.TrustedProxyCIDRs, mux)
	if err != nil {
		return err
	}
	server := newHTTPServer(cfg, proxied)
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", server.Addr, err)
	}
	server.Addr = listener.Addr().String()
	failed := make(chan error, 1)
	go func() {
		logger.Printf(`{"event":"server_started","listen_addr":%q}`, server.Addr)
		failed <- server.Serve(listener)
	}()
	select {
	case err := <-failed:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	}
}

func destinationMetadata(values []exporter.Destination) []httpapi.DestinationMetadata {
	result := make([]httpapi.DestinationMetadata, 0, len(values))
	for _, value := range values {
		public := value.Public()
		result = append(result, httpapi.DestinationMetadata{ID: public.ID, Label: public.Label, Description: public.Description, Kind: public.Kind, Retention: public.Retention})
	}
	return result
}

func newHTTPServer(cfg config.Config, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       cfg.ReadTimeout,
		WriteTimeout:      cfg.WriteTimeout,
		IdleTimeout:       cfg.IdleTimeout,
	}
}
