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

	"editapp/internal/api"
	"editapp/internal/app"
	"editapp/internal/auth"
	"editapp/internal/cache"
	"editapp/internal/config"
	exporter "editapp/internal/export"
	"editapp/internal/ffmpeg"
	"editapp/internal/httpx"
	"editapp/internal/jobs"
	"editapp/internal/limits"
	"editapp/internal/media/index"
	"editapp/internal/media/probe"
	"editapp/internal/metrics"
	"editapp/internal/projects"
	"editapp/internal/store"
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
	limiter, err := limits.NewPreview(cfg.PreviewGlobalLimit, cfg.PreviewPerUserLimit)
	if err != nil {
		return err
	}
	validator := cache.ValidatorFunc(func(ctx context.Context, path string) error {
		return ffmpeg.ValidateFile(ctx, cfg.FFprobePath, path)
	})
	previewManager, err := jobs.NewPreviewManager(cacheStore, ffmpeg.Runner{Path: cfg.FFmpegPath}, validator, limiter)
	if err != nil {
		return err
	}
	projectService, _ := projects.NewService(projectStore)
	refreshJobs := app.NewRefreshJobs()
	mediaAdapter := &app.MediaAdapter{Scanner: scanner, Store: mediaStore, Refresh: refreshJobs}
	previewAdapter := app.PreviewAdapter{Scanner: scanner, Media: mediaStore, Manager: previewManager, Cache: cacheStore, Validator: validator}
	projectAdapter := app.ProjectAdapter{Service: projectService, Store: projectStore}
	exportAdapter := app.NewExportAdapter(jobStore, scanner, mediaStore, exporter.Service{
		FFmpegPath: cfg.FFmpegPath, FFprobePath: cfg.FFprobePath, OutputDir: cfg.ExportDir,
	}, cfg.ExportLimit)
	jobAdapter := app.JobAdapter{Exports: exportAdapter, Refresh: refreshJobs}
	authenticator, err := auth.New(auth.Config{
		Mode: cfg.AuthMode, BearerToken: cfg.BearerToken, BearerSubject: cfg.BearerSubject,
	})
	if err != nil {
		return err
	}
	apiServer, err := api.New(api.Config{
		Authenticator: authenticator, Media: mediaAdapter, Preview: previewAdapter,
		Projects: projectAdapter, Exports: exportAdapter, Jobs: jobAdapter,
		Authorize: api.AuthorizerFunc(func(principal auth.Principal, action, resource string) bool {
			return principal.Allows(action, resource)
		}),
		Ready: db.PingContext, Logger: logger, Metrics: metrics.New(),
		BeforeMS: int64(cfg.PreviewBeforeMS), AfterMS: int64(cfg.PreviewAfterMS),
		MaxPreviewMS: int64(cfg.PreviewMaxMS), GridMS: int64(cfg.PreviewGridMS),
	})
	if err != nil {
		return err
	}

	mux := http.NewServeMux()
	mux.Handle("/api/", apiServer)
	mux.Handle("/metrics", apiServer)
	mux.Handle("/", http.FileServer(http.Dir("web/dist")))
	proxied, err := httpx.TrustedProxy(cfg.TrustedProxyCIDRs, mux)
	if err != nil {
		return err
	}
	server := newHTTPServer(cfg, httpx.CORS(cfg.AllowedOrigins, proxied))
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
