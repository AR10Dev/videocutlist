GO ?= go
GOFMT ?= gofmt
PNPM ?= pnpm
GO_PACKAGES := ./cmd/... ./internal/...
GO_TEST_PACKAGES := $(GO_PACKAGES) ./test/...

.PHONY: build check client-install e2e format lint smoke test test-real-media

build:
	$(PNPM) --dir client run build
	rm -rf internal/web/webassets/dist
	cp -a client/dist internal/web/webassets/dist
	$(GO) build -tags embed_frontend $(GO_PACKAGES)

check: lint test build
	$(GO) test -tags embed_frontend ./...
	$(GO) vet -tags embed_frontend ./...

format:
	$(GO) fmt $(GO_TEST_PACKAGES)
	$(PNPM) --dir client run format

lint:
	test -z "$$($(GOFMT) -l $$(find cmd internal test -type f -name '*.go'))"
	$(GO) vet $(GO_TEST_PACKAGES)
	$(PNPM) --dir client run lint

e2e:
	$(PNPM) --dir client run test:e2e

smoke: check e2e

test:
	$(GO) test -race $(GO_TEST_PACKAGES)
	$(PNPM) --dir client test

test-real-media:
	./test/harness/acquire-real-media.sh
	$(GO) test -tags realmedia -count=1 ./test/realmedia

client-install:
	$(PNPM) --dir client install --frozen-lockfile
