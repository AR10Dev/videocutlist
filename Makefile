GO ?= go
GOFMT ?= gofmt
NPM ?= npm
GO_PACKAGES = $(shell $(GO) list ./... | grep -v '/web/node_modules/')

.PHONY: build check format lint smoke test web-install

build:
	$(GO) build $(GO_PACKAGES)
	$(NPM) --prefix web run build

check: lint test build

format:
	$(GO) fmt $(GO_PACKAGES)
	$(NPM) --prefix web run format

lint:
	test -z "$$($(GOFMT) -l $$(find . -name '*.go' -not -path './.git/*' -not -path './web/node_modules/*'))"
	$(GO) vet $(GO_PACKAGES)
	$(NPM) --prefix web run lint

smoke: check

test:
	$(GO) test -race $(GO_PACKAGES)
	$(NPM) --prefix web test

web-install:
	$(NPM) --prefix web ci
