#!/usr/bin/env bash
set -euo pipefail

echo "🚀 Setting up Secure Collaborative Workspace"
echo "============================================="
echo ""

# Step 1: Add WASM target
echo "📦 Adding WASM target to Rust..."
if ! rustup target list | grep -q "wasm32-unknown-unknown (installed)"; then
    rustup target add wasm32-unknown-unknown
    echo "✓ WASM target added"
else
    echo "✓ WASM target already installed"
fi
echo ""

# Step 2: Install wasm-pack if not present
echo "📦 Checking for wasm-pack..."
if ! command -v wasm-pack &> /dev/null; then
    echo "Installing wasm-pack..."
    cargo install wasm-pack
    echo "✓ wasm-pack installed"
else
    echo "✓ wasm-pack already installed ($(wasm-pack --version))"
fi
echo ""

# Step 3: Install UI dependencies
echo "📦 Installing UI dependencies..."
cd ui
if [ ! -d "node_modules" ]; then
    npm install
    echo "✓ UI dependencies installed"
else
    echo "✓ UI dependencies already installed"
fi
cd ..
echo ""

echo "============================================="
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Build Rust crates: cargo build"
echo "  2. Run tests: cargo test"
echo "  3. Build WASM: make wasm"
echo "  4. Start dev server: make dev"
echo ""
echo "Or simply run: make all"
echo ""
