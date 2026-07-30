GO ?= go
GOFMT ?= gofmt
NPM ?= npm
GO_PACKAGES = ./cmd/... ./internal/...
GO_TEST_PACKAGES = ./cmd/... ./internal/... ./test/...

.PHONY: build check format lint smoke test web-install

build:
	$(GO) build $(GO_PACKAGES)
	$(NPM) --prefix web run build

check: lint test build

format:
	$(GO) fmt $(GO_TEST_PACKAGES)
	$(NPM) --prefix web run format

lint:
	test -z "$$($(GOFMT) -l $$(git ls-files '*.go'))"
	$(GO) vet $(GO_TEST_PACKAGES)
	$(NPM) --prefix web run lint

smoke: check

test:
	$(GO) test -race $(GO_TEST_PACKAGES)
	$(NPM) --prefix web test

web-install:
	$(NPM) --prefix web ci
