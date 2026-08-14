GO ?= go
GOFMT ?= gofmt
PNPM ?= pnpm
GO_PACKAGES := ./cmd/... ./domain/... ./application/... ./protocol/... ./infrastructure/...
GO_TEST_PACKAGES := $(GO_PACKAGES) ./test/...

.PHONY: architecture-check build check client-install deployment-check e2e format lint smoke test

build:
	$(GO) build $(GO_PACKAGES)
	$(PNPM) --dir client run build

check: lint test build

format:
	$(GO) fmt $(GO_TEST_PACKAGES)
	$(PNPM) --dir client run format

lint:
	test -z "$$($(GOFMT) -l $$(git ls-files '*.go'))"
	$(GO) vet $(GO_TEST_PACKAGES)
	$(PNPM) --dir client run lint

e2e:
	$(PNPM) --dir client run test:e2e

architecture-check:
	GO=$(GO) scripts/ops/check-architecture.sh

deployment-check:
	scripts/ops/check-deployment-files.sh

smoke: check architecture-check deployment-check e2e

test:
	$(GO) test -race $(GO_TEST_PACKAGES)
	$(PNPM) --dir client test

client-install:
	$(PNPM) --dir client install --frozen-lockfile
