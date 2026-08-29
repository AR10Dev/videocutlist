package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"syscall"
	"time"

	"videocutlist/application"
	"videocutlist/domain"
	"videocutlist/infrastructure/adapters"
	"videocutlist/infrastructure/assets"
	"videocutlist/infrastructure/cache"
	"videocutlist/infrastructure/config"
	detection "videocutlist/infrastructure/detection"
	exporter "videocutlist/infrastructure/export"
	"videocutlist/infrastructure/ffmpeg"
	"videocutlist/infrastructure/media/index"
	"videocutlist/infrastructure/media/probe"
	"videocutlist/infrastructure/store"
	"videocutlist/infrastructure/webassets"
	"videocutlist/protocol/http"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	logger := log.New(os.Stdout, "", 0)
	db, err := store.OpenDatabase(ctx, cfg.DatabasePath)
	if err != nil {
		return err
	}
	defer db.Close()
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
	jobStore, _ := store.NewJobStore(db)
	unifiedJobs, err := store.NewJobsStore(db)
	if err != nil {
		return err
	}
	mediaStore, _ := store.NewMediaStore(db)
	roots := make([]index.Root, 0, len(cfg.MediaRoots))
	aliases := make([]string, 0, len(cfg.MediaRoots))
	for alias := range cfg.MediaRoots {
		aliases = append(aliases, alias)
	}
	sort.Strings(aliases)
	for _, alias := range aliases {
		roots = append(roots, index.Root{Alias: alias, Path: cfg.MediaRoots[alias]})
	}
	scanner, err := index.NewScannerWithLimits(roots, probe.Client{Path: cfg.FFprobePath}, index.ScanLimits{MaxFiles: cfg.MediaMaxFiles, MaxDepth: cfg.MediaMaxDepth})
	if err != nil {
		return err
	}
	cacheStore, err := cache.New(cfg.CacheDir, cfg.CacheMaxBytes)
	if err != nil {
		return err
	}
	if err := cacheStore.CleanupPartials(); err != nil {
		return err
	}
	limiter, err := application.NewPreviewLimits(cfg.PreviewGlobalLimit, cfg.PreviewPerUserLimit)
	if err != nil {
		return err
	}
	validator := cache.ValidatorFunc(func(ctx context.Context, path string) error {
		return ffmpeg.ValidateFile(ctx, cfg.FFprobePath, path)
	})
	mediaCatalog := adapters.MediaCatalog{Scanner: scanner, Store: mediaStore}
	mediaService := &application.MediaUseCase{Catalog: mediaCatalog, Configured: len(cfg.MediaRoots) > 0}
	detectionService := application.NewDetectionUseCase(detection.Service{Scanner: scanner, Catalog: mediaStore, FFmpegPath: cfg.FFmpegPath, Capacity: limiter})
	detectionService.Catalog = mediaCatalog
	previewRunner := adapters.PreviewRunner{Scanner: scanner, Media: mediaStore, FFmpeg: ffmpeg.Runner{Path: cfg.FFmpegPath}}
	previewManager, err := application.NewPreviewManager(adapters.PreviewCache{Store: cacheStore}, previewRunner, application.Validator(validator), limiter)
	if err != nil {
		return err
	}
	previewService := application.PreviewUseCase{Catalog: mediaCatalog, Manager: previewManager}
	assetService := &assets.Service{Scanner: scanner, Media: mediaStore, FFmpegPath: cfg.FFmpegPath, CacheDir: cfg.CacheDir, MaxBytes: cfg.CacheMaxBytes, Capacity: limiter}
	projectService := application.ProjectUseCase{Repository: adapters.ProjectRepository{Store: projectStore}, Media: mediaCatalog}
	artifacts := exporter.NewArtifactStore()
	if err := artifacts.Reconcile(ctx, unifiedJobs, cfg.FFprobePath, cfg.Destinations); err != nil {
		return err
	}
	if _, err := unifiedJobs.Recover(ctx); err != nil {
		return err
	}
	artifacts.Cleanup(time.Now().UTC())
	go func() {
		ticker := time.NewTicker(15 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case now := <-ticker.C:
				artifacts.Cleanup(now.UTC())
			case <-ctx.Done():
				return
			}
		}
	}()
	exportExecutor := adapters.NewExportExecutor(jobStore, scanner, mediaStore, exporter.Service{
		FFmpegPath: cfg.FFmpegPath, FFprobePath: cfg.FFprobePath, OutputDir: cfg.ExportDir, Destinations: cfg.Destinations, Artifacts: artifacts, Capacity: limiter,
	})
	exportExecutor.Settings = runtimeState
	batchExports := application.BatchExportUseCase{Projects: adapters.ProjectRepository{Store: projectStore}, Media: mediaCatalog, Jobs: unifiedJobs, Settings: runtimeState}
	scheduler, err := store.NewScheduler(unifiedJobs, store.SchedulerConfig{QueueCapacity: cfg.ExportLimit * 4, WorkerLimit: cfg.ExportLimit}, func(ctx context.Context, job store.Job) error {
		switch job.Kind {
		case store.JobExport:
			if err := batchExports.RunQueuedSnapshot(ctx, job); err != nil {
				return err
			}
			artifacts.ClearManifest(job.ID)
			return nil
		case store.JobScan:
			scanErr := mediaService.RefreshMedia(ctx)
			result, err := json.Marshal(scanner.RootStatuses())
			if err != nil {
				return err
			}
			if scanErr != nil {
				_, err = unifiedJobs.FailWithResult(ctx, job.ID, string(result), "scan_failed")
				if err != nil {
					return err
				}
				return scanErr
			}
			_, err = unifiedJobs.Succeed(ctx, job.ID, string(result))
			return err
		case store.JobDetect:
			var request application.DetectionRequest
			if err := json.Unmarshal([]byte(job.RequestJSON), &request); err != nil {
				return err
			}
			if err := application.ValidateDetectionRequest(request); err != nil {
				return err
			}
			media, err := mediaCatalog.Get(ctx, request.MediaID)
			if err != nil {
				return err
			}
			if request.SourceFingerprint == "" || media.ETag != request.SourceFingerprint {
				return store.ErrSourceChanged
			}
			request.ProjectID = job.ProjectID
			candidates, err := detectionService.Detector.Detect(ctx, request)
			if err != nil {
				return err
			}
			data, err := json.Marshal(candidates)
			if err != nil {
				return err
			}
			_, err = unifiedJobs.Succeed(ctx, job.ID, string(data))
			return err
		default:
			return errors.New("unsupported job kind")
		}
	})
	if err != nil {
		return err
	}
	batchExports.Scheduler = scheduler
	mediaService.Scheduler, mediaService.UnifiedJobs = scheduler, unifiedJobs
	detectionService.Scheduler, detectionService.UnifiedJobs = scheduler, unifiedJobs
	if mediaService.Configured {
		if _, err := mediaService.StartImport(ctx); err != nil {
			return fmt.Errorf("start initial media scan: %w", err)
		}
	}
	batchExports.RunSnapshot = func(ctx context.Context, snapshot application.ExportSnapshot) error {
		return exportExecutor.ExecuteBatchSnapshot(ctx, snapshot.Item.ID, snapshot)
	}
	scheduler.Start()
	defer scheduler.Shutdown(context.Background())
	exportService := application.NewExportUseCase(jobStore, exportExecutor, cfg.ExportLimit)
	exportService.Settings = runtimeState
	exportService.SetLimitProvider(func() int { return runtimeState.Snapshot().ExportLimit })
	jobService := application.JobUseCase{Jobs: unifiedJobs}
	authenticator, err := httpapi.NewAuthenticator(httpapi.AuthConfig{
		Mode: cfg.AuthMode, BearerToken: cfg.BearerToken, BearerSubject: cfg.BearerSubject, ListenAddress: cfg.ListenAddress,
	})
	if err != nil {
		return err
	}
	applyRuntime := func(settings store.RuntimeSettings) error {
		previous := cfg.RuntimeSettings()
		roots := func(value store.RuntimeSettings) []index.Root {
			result := make([]index.Root, 0, len(value.MediaRoots))
			for alias, path := range value.MediaRoots {
				result = append(result, index.Root{Alias: alias, Path: path})
			}
			return result
		}
		return applyRuntimeSettingsTransactional(
			settings, previous,
			cfg.ApplyRuntimeSettings,
			func(value store.RuntimeSettings) error {
				return scanner.Reconfigure(ctx, roots(value), nil, mediaStore)
			},
			func(value store.RuntimeSettings) error {
				return scanner.ReconfigureLimits(index.ScanLimits{MaxFiles: value.MediaMaxFiles, MaxDepth: value.MediaMaxDepth})
			},
			func(value store.RuntimeSettings) error {
				return limiter.SetLimits(value.PreviewGlobalLimit, value.PreviewPerUserLimit)
			},
			func(value store.RuntimeSettings) error {
				return cacheStore.SetMaxBytes(value.CacheMaxBytes)
			},
		)
	}
	apiServer, err := httpapi.New(httpapi.Config{
		Authenticator: authenticator, Media: mediaService, Preview: previewService, Assets: assetService,
		Projects: projectService, Exports: exportService, BatchExports: batchExports, Preflight: exportExecutor, Jobs: jobService, Detection: detectionService, Download: exportExecutor, MediaImport: mediaService,
		Settings: runtimeSettingsStore, RuntimeSettings: runtimeState, ApplyRuntimeSettings: applyRuntime,
		Destinations: destinationMetadata(cfg.Destinations),
		Authorize: httpapi.AuthorizerFunc(func(principal domain.Principal, action, resource string) bool {
			return principal.Allows(action, resource)
		}),
		Ready: db.PingContext, Logger: logger, Metrics: httpapi.NewMetrics(),
		BeforeMS: int64(cfg.PreviewBeforeMS), AfterMS: int64(cfg.PreviewAfterMS),
		MaxPreviewMS: int64(cfg.PreviewMaxMS), GridMS: int64(cfg.PreviewGridMS), ListenerAddress: cfg.ListenAddress, RequireAutomationAuth: cfg.AuthMode != "none",
	})
	if err != nil {
		return err
	}

	mux := http.NewServeMux()
	mux.Handle("/api/", apiServer)
	mux.Handle("/metrics", apiServer)
	mux.Handle("/", webassets.DefaultHandler())
	proxied, err := httpapi.TrustedProxy(cfg.TrustedProxyCIDRs, mux)
	if err != nil {
		return err
	}
	server := newHTTPServer(cfg, httpapi.CORS(cfg.AllowedOrigins, proxied))
	failed := make(chan error, 1)
	go func() {
		logger.Printf(`{"event":"server_started","listen_addr":%q}`, server.Addr)
		failed <- server.ListenAndServe()
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
