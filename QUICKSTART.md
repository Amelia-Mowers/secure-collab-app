# Quick Start Guide

Get up and running with TideWork in 5 minutes.

## Prerequisites

Choose one:

**Option A: Using Nix (Recommended for NixOS users)**
- Install Nix with flakes enabled

**Option B: Manual Installation**
- Rust (latest stable)
- Node.js (v20+)
- wasm-pack

## Quick Start

### 1. Clone and Enter Environment

```bash
git clone <repository-url>
cd tidework

# Enter Nix shell (all dependencies included!)
nix develop
```

The Nix shell provides:
- ✅ Rust with WASM target pre-configured
- ✅ wasm-pack and build tools
- ✅ Node.js 20
- ✅ UI dependencies (auto-installed)

### 2. Build Everything

```bash
# Build Rust, WASM, and UI in one command:
make all
```

Or step-by-step:
```bash
cargo build              # Build Rust crates
cargo test               # Run tests
make wasm                # Build WASM modules
cd ui && npm run build   # Build UI
```

### 3. Start Development

```bash
# Start the dev server
make dev

# Or manually:
cd ui && npm run dev
```

Visit `http://localhost:5173` in your browser.

### Super Quick (One-Liner After Nix Shell)

```bash
make all && make dev
```

## Common Commands

```bash
# Format code
make fmt

# Run linter
make clippy

# Quick checks (format + lint + tests)
make quick

# Build for production
make ui

# Clean build artifacts
make clean

# View all commands
make help
```

## Project Structure

```
tidework/
├── crates/
│   ├── tables-over-matrix/    # Core library
│   └── app-core/              # App logic + WASM bridge
├── ui/                        # React frontend
├── tests/                     # Integration tests
├── flake.nix                  # Nix dev environment
└── Makefile                   # Development commands
```

## Next Steps

- Read [README.md](./README.md) for detailed documentation
- Read [architecture.md](./architecture.md) to understand the design
- Read [CONTRIBUTING.md](./CONTRIBUTING.md) to contribute

## Troubleshooting

### "cargo: command not found"

Make sure Rust is installed or you're in the Nix shell (`nix develop`).

### "wasm-pack: command not found"

Install wasm-pack:
```bash
cargo install wasm-pack

# Or use Nix shell:
nix develop
```

### "npm: command not found"

Install Node.js v20+ or use the Nix shell.

### Tests failing

Make sure you've built the project first:
```bash
cargo build
```

### WASM module not found in UI

Build the WASM modules:
```bash
make wasm
```

## Getting Help

- Check the [README.md](./README.md) for detailed documentation
- Open an issue on GitHub
- Read the architecture document for design context

## Development Workflow

1. Make changes to Rust code
2. Run tests: `cargo test`
3. If you changed the WASM bridge: `make wasm`
4. Make changes to UI code
5. UI auto-reloads if dev server is running
6. Before committing: `make quick`

Happy coding! 🚀
