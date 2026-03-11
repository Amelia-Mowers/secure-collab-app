.PHONY: help build test clean dev wasm ui install fmt clippy check

help: ## Show this help message
	@echo "Secure Collaborative Workspace - Development Commands"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install all dependencies
	@echo "Installing Rust dependencies..."
	cargo fetch
	@echo "Installing UI dependencies..."
	cd ui && npm install
	@echo "✓ All dependencies installed"

build: ## Build all crates
	@echo "Building Rust crates..."
	cargo build
	@echo "✓ Build complete"

wasm: ## Build WASM modules
	@echo "Building WASM modules..."
	cd crates/app-core && wasm-pack build --target web --out-dir ../../ui/src/wasm --no-default-features --features wasm
	@echo "✓ WASM build complete"

ui: wasm ## Build the UI (requires WASM)
	@echo "Building UI..."
	cd ui && npm run build
	@echo "✓ UI build complete"

dev: ## Start development servers
	@echo "Starting development environment..."
	@echo "Note: Run 'make wasm' first if you haven't built the WASM modules"
	cd ui && npm run dev

test: ## Run all tests
	@echo "Running Rust tests..."
	cargo test
	@echo "Running UI tests..."
	cd ui && npm test
	@echo "✓ All tests passed"

test-unit: ## Run only unit tests (fast)
	cargo test --lib

test-integration: ## Run integration tests (requires homeserver)
	cargo test --test two_client_sync --ignored
	cargo test --test cold_start --ignored

test-property: ## Run property-based tests
	cargo test --release -- lww_properties

fmt: ## Format code
	@echo "Formatting Rust code..."
	cargo fmt --all
	@echo "Formatting UI code..."
	cd ui && npm run lint -- --fix
	@echo "✓ Code formatted"

clippy: ## Run Clippy linter
	cargo clippy --all-targets --all-features -- -D warnings

check: ## Quick check without building
	cargo check --all-targets

clean: ## Clean build artifacts
	@echo "Cleaning Rust build artifacts..."
	cargo clean
	@echo "Cleaning UI build artifacts..."
	cd ui && rm -rf dist node_modules
	@echo "Cleaning WASM artifacts..."
	rm -rf ui/src/wasm
	@echo "✓ Cleaned"

doc: ## Generate and open documentation
	cargo doc --open --no-deps

watch: ## Watch for changes and rebuild
	cargo watch -x check -x test

benchmarks: ## Run benchmarks
	cargo bench

all: clean install build wasm ui test ## Clean, install, build, and test everything
	@echo "✓ Complete rebuild successful"

# Development helpers
nix-shell: ## Enter Nix development shell
	nix develop

nix-build: ## Build using Nix
	nix build

# Quick development cycle
quick: fmt clippy test-unit ## Format, lint, and run unit tests (fast)
	@echo "✓ Quick checks passed"
