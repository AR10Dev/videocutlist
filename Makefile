GO ?= go
GOFMT ?= gofmt
PNPM ?= pnpm
GO_PACKAGES := ./cmd/... ./domain/... ./application/... ./protocol/... ./infrastructure/...
GO_TEST_PACKAGES := $(GO_PACKAGES) ./test/...

.PHONY: build check client-install e2e format lint smoke test

build:
	$(PNPM) --dir client run build
	rm -rf infrastructure/webassets/dist
	cp -a client/dist infrastructure/webassets/dist
	$(GO) build -tags embed_frontend $(GO_PACKAGES)

check: lint test build
	$(GO) test -tags embed_frontend ./...
	$(GO) vet -tags embed_frontend ./...

format:
	$(GO) fmt $(GO_TEST_PACKAGES)
	$(PNPM) --dir client run format

lint:
	test -z "$$($(GOFMT) -l $$(git ls-files '*.go'))"
	$(GO) vet $(GO_TEST_PACKAGES)
	$(PNPM) --dir client run lint

e2e:
	$(PNPM) --dir client run test:e2e

smoke: check e2e

test:
	$(GO) test -race $(GO_TEST_PACKAGES)
	$(PNPM) --dir client test

client-install:
	$(PNPM) --dir client install --frozen-lockfile
