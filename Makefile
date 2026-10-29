GO ?= go
GOFMT ?= gofmt
GOLANGCI_LINT ?= golangci-lint
PNPM ?= pnpm
GO_PACKAGES := ./cmd/... ./internal/...
SHELL_FILES := $(shell find scripts deployments test -type f -name '*.sh')
DATA_DIR ?= .cache/videocutlist

.PHONY: build check clean clean-deps clean-all generate-go-api web-install e2e format lint run smoke test test-unit test-podman test-real-media

# Regenerate Go transport types from the shared OpenAPI source.
generate-go-api:
	$(GO) tool oapi-codegen -config api/oapi-codegen.yaml api/api.openapi.yaml

build:
	$(PNPM) --dir web run build
	rm -rf internal/web/webassets/dist
	cp -a web/dist internal/web/webassets/dist
	$(GO) build -tags embed_frontend $(GO_PACKAGES)

# Remove reproducible output only; preserve dependencies and application data.
clean:
	rm -rf -- web/dist internal/web/webassets/dist \
		web/test-results web/playwright-report web/blob-report \
		test-results playwright-report blob-report coverage \
		web/node_modules/.vite web/node_modules/.vite-temp node_modules/.vite
	rm -f -- videocutlist videocutlist.exe *.test *.tsbuildinfo web/*.tsbuildinfo

# Reinstall with make web-install after removing repository-local dependencies.
clean-deps: clean
	rm -rf -- node_modules web/node_modules .pnpm-store

# Run only with development servers/tests stopped. Never remove application data.
clean-all: clean-deps
	rm -rf -- .devenv .direnv test/fixtures/real-media \
		.cache/real-ui .cache/real-ui.* .cache/ui-repro .cache/ui-repro-vite.log

run:
	VIDEOCUTLIST_DATABASE_PATH="$${VIDEOCUTLIST_DATABASE_PATH:-$(DATA_DIR)/videocutlist.db}" \
	VIDEOCUTLIST_CACHE_DIR="$${VIDEOCUTLIST_CACHE_DIR:-$(DATA_DIR)/cache}" \
	VIDEOCUTLIST_EXPORT_DIR="$${VIDEOCUTLIST_EXPORT_DIR:-$(DATA_DIR)/exports}" \
	VIDEOCUTLIST_MEDIA_ROOTS_JSON="$${VIDEOCUTLIST_MEDIA_ROOTS_JSON:-{}}" \
	$(GO) run ./cmd/videocutlist

check: lint build test-unit
	$(GO) vet -tags embed_frontend ./...

format:
	$(GOFMT) -w $$(find cmd internal test -type f -name '*.go')
	$(PNPM) --dir web run format

lint:
	node scripts/check-layout.mjs
	test -z "$$($(GOFMT) -l $$(find cmd internal test -type f -name '*.go'))"
	$(GOLANGCI_LINT) run ./...
	status=0; for file in $(SHELL_FILES); do shellcheck "$$file" || status=1; done; test "$$status" -eq 0
	test -z "$$(shfmt -d $(SHELL_FILES))"
	$(PNPM) --dir web run lint
	$(PNPM) --dir web run format:check

e2e:
	$(PNPM) --dir web run test:e2e

smoke: check e2e

test: test-unit e2e

test-unit:
	$(GO) test $(GO_PACKAGES)
	$(PNPM) --dir web run test:lint

test-podman:
	./scripts/deploy-podman-local.sh --smoke-test

test-real-media:
	./test/harness/acquire-real-media.sh
	$(PNPM) --dir web run build
	rm -rf internal/web/webassets/dist
	cp -a web/dist internal/web/webassets/dist
	$(GO) test -tags realmedia -count=1 -v ./test/realmedia
	$(MAKE) e2e

web-install:
	$(PNPM) install --frozen-lockfile
	$(PNPM) --dir web install --frozen-lockfile
