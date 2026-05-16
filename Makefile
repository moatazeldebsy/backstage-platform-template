.PHONY: cli-build cli-install cli-clean

cli-build: ## Build the idp CLI binary to ./bin/idp
	cd cli && go build -ldflags "-X main.version=$$(git describe --tags --always --dirty 2>/dev/null || echo dev)" -o ../bin/idp ./cmd/idp

cli-install: ## Install the idp CLI to $(GOPATH)/bin
	cd cli && go install ./cmd/idp
	@echo "Installed to $$(go env GOPATH)/bin/idp"
	@echo "If 'idp' is not found, add this to your shell profile:"
	@echo "  export PATH=\"\$$(go env GOPATH)/bin:\$$PATH\""

cli-clean: ## Remove the built binary
	rm -f bin/idp
