#!/usr/bin/env bash
set -euo pipefail

# Build script for Secure Collaborative Workspace

echo "🔨 Building Secure Collaborative Workspace"
echo "=========================================="
echo ""

# Check if we're in a Nix shell
if [ -z "${IN_NIX_SHELL:-}" ]; then
    echo "⚠️  Not in a Nix shell. Checking for dependencies..."

    # Check for required tools
    command -v cargo >/dev/null 2>&1 || { echo "❌ cargo not found. Please install Rust or use 'nix develop'"; exit 1; }
    command -v wasm-pack >/dev/null 2>&1 || { echo "❌ wasm-pack not found. Please install it or use 'nix develop'"; exit 1; }
    command -v npm >/dev/null 2>&1 || { echo "❌ npm not found. Please install Node.js or use 'nix develop'"; exit 1; }

    echo "✓ All required tools found"
    echo ""
fi

# Build Rust crates
echo "📦 Building Rust crates..."
cargo build --release
echo "✓ Rust build complete"
echo ""

# Build WASM modules
echo "🌐 Building WebAssembly modules..."
cd crates/app-core
wasm-pack build --target web --out-dir ../../ui/src/wasm --release
cd ../..
echo "✓ WASM build complete"
echo ""

# Install UI dependencies if needed
if [ ! -d "ui/node_modules" ]; then
    echo "📦 Installing UI dependencies..."
    cd ui
    npm install
    cd ..
    echo "✓ UI dependencies installed"
    echo ""
fi

# Build UI
echo "🎨 Building UI..."
cd ui
npm run build
cd ..
echo "✓ UI build complete"
echo ""

echo "=========================================="
echo "✅ Build successful!"
echo ""
echo "Next steps:"
echo "  • Run tests: make test"
echo "  • Start dev server: make dev"
echo "  • View documentation: cargo doc --open"
echo ""
