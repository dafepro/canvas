.PHONY: help install generate export-canvases build test test-go test-ts up down logs demo net-status net-clear clean

help: ## Show the available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install the JavaScript and Go dependencies
	pnpm install
	cd server && go mod download

generate: ## Regenerate the protobuf bindings for TypeScript and Go
	pnpm --filter @canvas-physics/protocol generate
	cd server && bash scripts/generate.sh

export-canvases: ## Write the canvas JSON files the server loads
	node scripts/export-canvases.mjs

build: export-canvases ## Type-check and build every package
	pnpm -r --filter "./packages/*" build
	pnpm --filter @canvas-physics/demo build
	cd server && go build ./...

test: test-ts test-go ## Run every test

test-ts: ## Run the TypeScript tests
	pnpm vitest run

test-go: ## Run the Go tests with the race detector
	cd server && go test ./... -race

up: export-canvases ## Start the local stack in Docker
	docker compose up --build -d
	@echo ""
	@echo "demo:        http://localhost:5173"
	@echo "impaired:    http://localhost:8081  (through Toxiproxy)"
	@echo "direct:      http://localhost:8080"
	@echo "toxiproxy:   http://localhost:8474"

down: ## Stop the local stack
	docker compose down -v

logs: ## Follow the service logs
	docker compose logs -f canvasd

demo: ## Run the demo with Vite against a local canvasd
	pnpm --filter @canvas-physics/demo dev

net-status: ## Show the active network impairment
	scripts/net.sh status

net-clear: ## Remove every network impairment
	scripts/net.sh clear

clean: ## Remove build output
	rm -rf packages/*/dist apps/demo/dist server/canvasd
