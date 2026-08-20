package main

import (
	"context"
	"errors"
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
	projectStore, _ := store.NewProjectStore(db)
	jobStore, _ := store.NewJobStore(db)
	detectionStore, _ := store.NewDetectionJobStore(db)
	mediaStore, _ := store.NewMediaStore(db)
	if _, err := jobStore.Recover(ctx); err != nil {
		return err
	}

	roots := make([]index.Root, 0, len(cfg.MediaRoots))
	aliases := make([]string, 0, len(cfg.MediaRoots))
	for alias := range cfg.MediaRoots {
		aliases = append(aliases, alias)
	}
	sort.Strings(aliases)
	for _, alias := range aliases {
		roots = append(roots, index.Root{Alias: alias, Path: cfg.MediaRoots[alias]})
	}
	scanner, err := index.NewScanner(roots, probe.Client{Path: cfg.FFprobePath})
	if err != nil {
		return err
	}
	if err := scanner.Refresh(ctx, mediaStore); err != nil {
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
	previewRunner := adapters.PreviewRunner{Scanner: scanner, Media: mediaStore, FFmpeg: ffmpeg.Runner{Path: cfg.FFmpegPath}}
	previewManager, err := application.NewPreviewManager(adapters.PreviewCache{Store: cacheStore}, previewRunner, application.Validator(validator), limiter)
	if err != nil {
		return err
	}
	mediaService := &application.MediaUseCase{Catalog: mediaCatalog}
	previewService := application.PreviewUseCase{Catalog: mediaCatalog, Manager: previewManager}
	assetService := &assets.Service{Scanner: scanner, Media: mediaStore, FFmpegPath: cfg.FFmpegPath, CacheDir: cfg.CacheDir, MaxBytes: cfg.CacheMaxBytes}
	projectService := application.ProjectUseCase{Repository: adapters.ProjectRepository{Store: projectStore}}
	exportExecutor := adapters.NewExportExecutor(jobStore, scanner, mediaStore, exporter.Service{
		FFmpegPath: cfg.FFmpegPath, FFprobePath: cfg.FFprobePath, OutputDir: cfg.ExportDir,
	})
	exportService := application.NewExportUseCase(jobStore, exportExecutor, cfg.ExportLimit)
	detectionService := application.NewDetectionUseCase(detectionStore, detection.Service{Scanner: scanner, Catalog: mediaStore, FFmpegPath: cfg.FFmpegPath}, cfg.ExportLimit)
	jobService := application.JobUseCase{Exports: exportService, Detections: detectionService}
	authenticator, err := httpapi.NewAuthenticator(httpapi.AuthConfig{
		Mode: cfg.AuthMode, BearerToken: cfg.BearerToken, BearerSubject: cfg.BearerSubject,
	})
	if err != nil {
		return err
	}
	apiServer, err := httpapi.New(httpapi.Config{
		Authenticator: authenticator, Media: mediaService, Preview: previewService, Assets: assetService,
		Projects: projectService, Exports: exportService, Jobs: jobService, Detection: detectionService,
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
	mux.Handle("/", webassets.Handler("client/dist"))
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
