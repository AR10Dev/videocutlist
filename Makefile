GO ?= go
GOFMT ?= gofmt
GOLANGCI_LINT ?= golangci-lint
PNPM ?= pnpm
GO_PACKAGES := ./cmd/... ./internal/...
GO_TEST_PACKAGES := $(GO_PACKAGES) ./test/...
SHELL_FILES := $(shell find scripts deployments test -type f -name '*.sh')
DATA_DIR ?= .cache/videocutlist

.PHONY: build check client-install e2e format lint run smoke test test-podman test-real-media

build:
	$(PNPM) --dir client run build
	rm -rf internal/web/webassets/dist
	cp -a client/dist internal/web/webassets/dist
	$(GO) build -tags embed_frontend $(GO_PACKAGES)

run:
	VIDEOCUTLIST_DATABASE_PATH="$${VIDEOCUTLIST_DATABASE_PATH:-$(DATA_DIR)/videocutlist.db}" \
	VIDEOCUTLIST_CACHE_DIR="$${VIDEOCUTLIST_CACHE_DIR:-$(DATA_DIR)/cache}" \
	VIDEOCUTLIST_EXPORT_DIR="$${VIDEOCUTLIST_EXPORT_DIR:-$(DATA_DIR)/exports}" \
	VIDEOCUTLIST_MEDIA_ROOTS_JSON="$${VIDEOCUTLIST_MEDIA_ROOTS_JSON:-{}}" \
	$(GO) run ./cmd/videocutlist

check: lint test build
	$(GO) test -tags embed_frontend ./...
	$(GO) vet -tags embed_frontend ./...

format:
	$(GO) fmt $(GO_TEST_PACKAGES)
	$(PNPM) --dir client run format

lint:
	test -z "$$($(GOFMT) -l $$(find cmd internal test -type f -name '*.go'))"
	$(GOLANGCI_LINT) run ./...
	$(GO) vet $(GO_TEST_PACKAGES)
	for file in $(SHELL_FILES); do shellcheck "$$file"; done
	test -z "$$(shfmt -d $(SHELL_FILES))"
	$(PNPM) --dir client run lint

e2e:
	$(PNPM) --dir client run test:e2e

smoke: check e2e

test:
	$(GO) test -race $(GO_TEST_PACKAGES)
	$(PNPM) --dir client test

test-podman:
	./scripts/deploy-podman-local.sh

test-real-media:
	./test/harness/acquire-real-media.sh
	$(PNPM) --dir client run build
	rm -rf internal/web/webassets/dist
	cp -a client/dist internal/web/webassets/dist
	$(GO) test -tags realmedia -count=1 -v ./test/realmedia

client-install:
	$(PNPM) install --frozen-lockfile
	$(PNPM) --dir client install --frozen-lockfile
