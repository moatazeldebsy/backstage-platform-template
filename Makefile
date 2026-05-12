.PHONY: cli-build cli-install cli-clean

cli-build: ## Build the idp CLI binary to ./bin/idp
	cd cli && go build -o ../bin/idp ./cmd/idp

cli-install: ## Install the idp CLI to /usr/local/bin
	cd cli && go install ./cmd/idp

cli-clean: ## Remove the built binary
	rm -f bin/idp
