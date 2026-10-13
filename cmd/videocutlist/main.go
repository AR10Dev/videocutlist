package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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
	"videocutlist/internal/jobs/model"
	"videocutlist/internal/jobs/view"
	librarymedia "videocutlist/internal/library/media"
	librarycatalog "videocutlist/internal/library/media/catalog"
	"videocutlist/internal/library/media/index"
	"videocutlist/internal/library/media/probe"
	"videocutlist/internal/mcp"
	"videocutlist/internal/preview"
	"videocutlist/internal/preview/adapters"
	"videocutlist/internal/preview/assets"
	"videocutlist/internal/preview/cache"
	"videocutlist/internal/preview/ffmpeg"
	"videocutlist/internal/projects"
	"videocutlist/internal/runtime"
	"videocutlist/internal/settings"
	settingsmodel "videocutlist/internal/settings/model"
	"videocutlist/internal/web/webassets"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	return runWithCleanupExit(ctx, nil)
}

func runWithCleanupExit(ctx context.Context, cleanupExited chan struct{}) (runErr error) {
	cleanupCtx, cancelCleanup := context.WithCancel(ctx)
	defer cancelCleanup()

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
	mcpStorage, err := store.NewMCPStorage(db)
	if err != nil {
		return err
	}
	mcpCredentials, err := mcp.NewCredentialStore(mcpStorage)
	if err != nil {
		return err
	}
	runtimeSettingsStore, err := store.NewRuntimeSettingsStore(db)
	if err != nil {
		return err
	}
	effectiveSettings, err := config.BootstrapRuntimeSettings(ctx, runtimeSettingsStore, cfg.RuntimeSettings())
	if err != nil {
		return err
	}
	if err := cfg.ApplyRuntimeSettings(effectiveSettings.Settings); err != nil {
		return fmt.Errorf("load runtime settings: %w", err)
	}
	runtimeState := settingsmodel.NewRuntimeSettingsState(effectiveSettings.Settings)
	projectStore, err := store.NewProjectStore(db)
	if err != nil {
		return fmt.Errorf("create project store: %w", err)
	}
	jobStorage, err := store.NewJobStorage(db)
	if err != nil {
		return err
	}
	unifiedJobs, err := jobqueue.NewJobsStore(jobStorage)
	if err != nil {
		return err
	}
	mediaStore, err := store.NewMediaStore(db)
	if err != nil {
		return fmt.Errorf("create media store: %w", err)
	}
	if err := mediaStore.ReconcileRoots(ctx, cfg.MediaRoots); err != nil {
		return fmt.Errorf("reconcile configured media roots: %w", err)
	}
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
	limiter, err := preview.NewPreviewLimits(cfg.PreviewGlobalLimit)
	if err != nil {
		return err
	}
	validator := func(ctx context.Context, file *os.File) error {
		return ffmpeg.ValidateFile(ctx, cfg.FFprobePath, file)
	}
	mediaCatalog := librarycatalog.MediaCatalog{Scanner: scanner, Store: mediaStore}
	mediaService := &librarymedia.MediaUseCase{Catalog: mediaCatalog, Configured: len(cfg.MediaRoots) > 0}
	mediaImportService := &librarymedia.ImportUseCase{Configured: len(cfg.MediaRoots) > 0, UnifiedJobs: unifiedJobs}
	detector := &detection.Service{Scanner: scanner, Catalog: mediaStore, FFmpegPath: cfg.FFmpegPath, Capacity: limiter}
	detectionService := projects.NewDetectionUseCase(detector)
	detectionService.Catalog = mediaCatalog
	detectionService.Projects = projects.StoreRepository{Store: projectStore}
	previewRunner := adapters.PreviewRunner{Scanner: scanner, Media: mediaStore, FFmpeg: ffmpeg.Runner{Path: cfg.FFmpegPath}}
	previewManager, err := preview.NewPreviewManager(adapters.PreviewCache{Store: cacheStore}, previewRunner, validator, limiter)
	if err != nil {
		return err
	}
	previewService := preview.PreviewUseCase{Catalog: mediaCatalog, Manager: previewManager}
	assetService := &assets.Service{Scanner: scanner, Media: mediaStore, FFmpegPath: cfg.FFmpegPath, CacheDir: cfg.CacheDir, MaxBytes: timelineCacheBytes, Capacity: limiter}
	projectService := projects.ProjectUseCase{Repository: projects.StoreRepository{Store: projectStore}, Media: mediaCatalog}
	artifacts := exporter.NewArtifactStore()
	if err := artifacts.Reconcile(ctx, unifiedJobs, cfg.FFprobePath, cfg.Destinations); err != nil {
		return err
	}
	if _, err := unifiedJobs.Recover(ctx); err != nil {
		return err
	}
	artifacts.Cleanup(time.Now().UTC())
	go func() {
		defer func() {
			if cleanupExited != nil {
				close(cleanupExited)
			}
		}()
		ticks := time.Tick(15 * time.Minute)
		for {
			select {
			case now := <-ticks:
				artifacts.Cleanup(now.UTC())
			case <-cleanupCtx.Done():
				return
			}
		}
	}()
	exportExecutor := exporter.Executor{
		Jobs: unifiedJobs, Scanner: scanner, Media: mediaStore,
		Service:  exporter.Service{FFmpegPath: cfg.FFmpegPath, FFprobePath: cfg.FFprobePath, OutputDir: cfg.ExportDir, Destinations: cfg.Destinations, Artifacts: artifacts, Capacity: limiter},
		Settings: runtimeState,
	}
	batchExports := projects.BatchExportUseCase{Projects: projects.StoreRepository{Store: projectStore}, Media: mediaCatalog, Jobs: unifiedJobs, Settings: runtimeState}
	queuedExports := exporter.QueuedExecutor{Jobs: unifiedJobs, Media: mediaCatalog, RunSnapshot: exportExecutor.RunSnapshot, RemoveArtifacts: artifacts.Remove}
	queuedJobs := runtime.QueuedJobs{Exports: queuedExports, Scans: librarymedia.ScanExecutor{Jobs: unifiedJobs, Media: mediaService, Catalog: mediaCatalog}, Detection: detection.QueuedExecutor{Jobs: unifiedJobs, Catalog: mediaCatalog, Detector: detector}}
	batchDownloads := exporter.BatchArchiveService{Jobs: unifiedJobs, Service: exportExecutor.Service, Downloads: exportExecutor}
	scheduler, err := jobqueue.NewScheduler(unifiedJobs, jobqueue.SchedulerConfig{QueueCapacity: cfg.ExportLimit * 4, WorkerLimit: cfg.ExportLimit, Logger: logger}, queuedJobs.Run)
	if err != nil {
		return err
	}
	batchExports.Scheduler = scheduler
	mediaImportService.Scheduler = scheduler
	detectionService.Scheduler, detectionService.UnifiedJobs = scheduler, unifiedJobs
	scheduler.Start()
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := scheduler.Shutdown(cleanup); err != nil {
			runErr = errors.Join(runErr, fmt.Errorf("shutdown jobs: %w", err))
		}
	}()
	if mediaService.Configured {
		startupKey := make([]byte, 16)
		if _, err := rand.Read(startupKey); err != nil {
			return fmt.Errorf("create startup scan key: %w", err)
		}
		if _, err := mediaImportService.StartImport(ctx, "startup-"+hex.EncodeToString(startupKey)); err != nil && !errors.Is(err, model.ErrQueueFull) {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("start initial media scan: %w", err)
		}
	}
	jobService := view.JobUseCase{Jobs: unifiedJobs}
	authenticator, err := httpapi.NewAuthenticator(httpapi.AuthConfig{
		Mode: cfg.AuthMode, BearerToken: cfg.BearerToken, ListenAddress: cfg.ListenAddress, TrustedProxyCIDRs: cfg.TrustedProxyCIDRs,
	})
	if err != nil {
		return err
	}
	settingsApplier := runtime.RuntimeSettingsApplier{State: runtimeState, Scanner: scanner, PreviewLimits: limiter, PreviewCache: cacheStore, Assets: assetService, Scheduler: scheduler}
	proposalService, err := mcp.NewProposalService(mcpStorage, mcpCredentials, projectService, mediaCatalog, projects.ExportPreflightUseCase{Export: exportExecutor}, scheduler)
	if err != nil {
		return err
	}
	apiServer, err := httpapi.New(httpapi.Config{
		Authenticator: authenticator, Media: mediaService, Preview: previewService, Assets: assetService,
		Projects: projectService, BatchExports: batchExports, Preflight: projects.ExportPreflightUseCase{Export: exportExecutor}, Jobs: jobService, Detection: detectionService, Download: exportExecutor, BatchDownload: batchDownloads, MediaImport: mediaImportService,
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
		Logger:                logger,
		PublicBaseURL:         cfg.PublicBaseURL,
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
	mux.Handle("/api", apiServer)
	mux.Handle("/api/", apiServer)
	mux.Handle("/media", apiServer)
	mux.Handle("/media/", apiServer)
	mux.Handle("/health", apiServer)
	mux.Handle("/ready", apiServer)
	mux.Handle("/metrics", apiServer)
	mux.Handle("/", httpapi.CORS(cfg.AllowedOrigins, webassets.DefaultHandler()))
	handler := http.Handler(mux)
	if cfg.AuthMode == "none" {
		handler = httpapi.HostGuard(cfg.Port, cfg.PublicBaseURL, handler)
	}
	proxied, err := httpapi.TrustedProxy(cfg.TrustedProxyCIDRs, handler)
	if err != nil {
		return err
	}
	server := newHTTPServer(cfg, proxied)
	server.RegisterOnShutdown(apiServer.Shutdown)
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
	case serveErr := <-failed:
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		shutdownErr := shutdownHTTPServer(server, mcpTransport, shutdown, 10*time.Second)
		if errors.Is(serveErr, http.ErrServerClosed) {
			return shutdownErr
		}
		return errors.Join(fmt.Errorf("serve HTTP: %w", serveErr), shutdownErr)
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return shutdownHTTPServer(server, mcpTransport, shutdown, 10*time.Second)
	}
}

func shutdownHTTPServer(server *http.Server, mcpTransport *mcp.Transport, gracefulCtx context.Context, cleanupTimeout time.Duration) error {
	httpErr := server.Shutdown(gracefulCtx)
	var closeErr error
	if httpErr != nil {
		closeErr = server.Close()
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
	defer cancel()
	mcpErr := mcpTransport.Shutdown(cleanupCtx)
	if httpErr != nil {
		httpErr = fmt.Errorf("drain HTTP server: %w", httpErr)
	}
	if closeErr != nil {
		closeErr = fmt.Errorf("close HTTP server: %w", closeErr)
	}
	if mcpErr != nil {
		mcpErr = fmt.Errorf("drain MCP application calls: %w", mcpErr)
	}
	return errors.Join(httpErr, closeErr, mcpErr)
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
