# TideWork

**[tidework.io](https://tidework.io)** — an open-source, end-to-end encrypted, real-time collaborative workspace built on the Matrix protocol. Think Notion or Airtable, but with genuine E2E encryption, federation, and full data sovereignty.

## Features

- **🔐 End-to-End Encrypted**: All data is encrypted using Matrix's Megolm protocol
- **🌐 Federated**: Collaborate across different Matrix homeservers
- **📊 Flexible Views**: View your data as tables, kanban boards, calendars, or task lists
- **📝 Entry View**: Full-page interface for viewing and editing individual rows with multiple field types
- **📄 Document Cells**: Markdown document cells with live preview for rich content
- **🔄 Real-time Sync**: Changes sync instantly across all devices
- **🏗️ LWW CRDTs**: Last-Write-Wins conflict resolution for seamless collaboration
- **⚡ Efficient Cold Start**: Order-based bumping bounds lookback windows
- **🦀 Rust Core**: High-performance core compiled to WebAssembly

## Architecture

See [architecture.md](./architecture.md) for a detailed architecture overview.

### Three-Layer Stack

1. **`tables-over-matrix`** (Rust): Pure library for LWW cells over Matrix
2. **`app-core`** (Rust): Application-specific logic and WASM bridge
3. **`ui`** (TypeScript/React): Thin view layer

## Prerequisites

### Using Nix (Recommended)

If you're on NixOS or using Nix, the development environment is fully reproducible:

```bash
# Enter the Nix development shell
nix develop

# Or use the legacy nix-shell
nix-shell

# If you get disk space errors, run garbage collection first:
nix-collect-garbage -d
```

The Nix shell automatically provides **everything** you need:
- Rust toolchain with WASM target (wasm32-unknown-unknown)
- wasm-pack and wasm-bindgen-cli
- Node.js 20
- Build tools (pkg-config, openssl, sqlite)
- UI dependencies (auto-installed on first run)

No additional setup needed! Just `nix develop` and you're ready to code.

### Manual Setup

If not using Nix, you'll need:

- **Rust** (latest stable): https://rustup.rs/
  ```bash
  rustup install stable
  rustup target add wasm32-unknown-unknown
  ```

- **Node.js** (v20+): https://nodejs.org/

- **wasm-pack**:
  ```bash
  cargo install wasm-pack
  ```

- **System dependencies**:
  - pkg-config
  - openssl
  - sqlite

  On Ubuntu/Debian:
  ```bash
  sudo apt install pkg-config libssl-dev libsqlite3-dev
  ```

  On macOS:
  ```bash
  brew install pkg-config openssl sqlite
  ```

## Project Structure

```
secure-collab-app/
├── crates/
│   ├── tables-over-matrix/    # Core library for LWW tables over Matrix
│   │   └── tests/             # Unit + Conduit integration tests
│   └── app-core/              # Application logic and WASM bridge
│       └── tests/             # Workspace + Matrix integration tests
├── ui/                        # React/TypeScript frontend
│   └── e2e/                   # Two-browser Playwright tests (real WASM + Conduit)
├── docs/adr/                  # Architecture decision records
├── scripts/                   # Integration-test runner, build helpers
├── flake.nix                  # Nix development environment
└── Cargo.toml                 # Rust workspace manifest
```

## Getting Started

### 1. Clone and Enter Development Environment

```bash
cd secure-collab-app

# Enter Nix shell (if using Nix)
nix develop

# The shell automatically:
# - Provides Rust with WASM target
# - Installs wasm-pack and build tools
# - Installs UI dependencies (first run)
```

### 2. Build the Rust Libraries

```bash
# Build all Rust crates
cargo build

# Run tests
cargo test

# Run property-based tests
cargo test --release
```

### 3. Build WASM Modules

```bash
# Build the app-core crate for WebAssembly:
make wasm

# Equivalent manual command:
cd crates/app-core && wasm-pack build --target web --out-dir ../../ui/src/wasm/generated \
  --no-default-features --features wasm,matrix-wasm
```

### 4. Run the UI

```bash
# Start development server
cd ui
npm run dev

# Or using make from project root:
make dev
```

The development server will be available at `http://localhost:5173`.

### Quick Start (All-in-One)

```bash
nix develop    # Enter environment
make all       # Build everything and run tests
make dev       # Start dev server
```

## Development Workflow

### Running Tests

#### Unit and Property Tests

```bash
# Run all unit tests
cargo test

# Run tests for a specific crate
cargo test -p tables-over-matrix
cargo test -p app-core

# Run property-based tests with more iterations
cargo test --release -- --nocapture
```

#### Integration Tests

Integration tests run against a real, throwaway Conduit homeserver (provided by
the Nix dev shell) and cover two-client sync, encrypted round-trips, cold start,
key backup/recovery, and SAS verification:

```bash
nix develop --command bash scripts/run-integration-tests.sh
```

#### UI Tests

```bash
cd ui

# Run UI tests
npm test

# Type checking
npm run type-check

# Linting
npm run lint
```

#### End-to-end browser tests

A two-browser Playwright harness drives the **real compiled WASM** against a
live Conduit — covering registration, recovery, SAS verification, and the core
single-device product journey (including reload persistence). See
[`ui/e2e/README.md`](./ui/e2e/README.md):

```bash
nix develop --command bash -c "cd ui && npm run e2e"
```

### Code Quality

```bash
# Format code
cargo fmt

# Run clippy (linter)
cargo clippy -- -D warnings

# Check without building
cargo check
```

## Library Documentation

### tables-over-matrix

Core library for building collaborative tables over Matrix.

**Key Features:**
- LWW conflict resolution
- Efficient table materialization
- Order-based bumping for compaction
- Cold start from timeline

**Example:**

```rust
use tables_over_matrix::{Table, CellUpdate};
use serde_json::json;

let mut table = Table::new("my_table");

// Apply updates
let update = CellUpdate::new("my_table", "row1", "col1", json!("hello"), 100);
table.apply_update(update);

// Read values
assert_eq!(table.get_value("row1", "col1"), Some(&json!("hello")));
```

### app-core

Application-specific logic built on tables-over-matrix.

**Key Features:**
- Workspace management
- System table conventions (schema, views)
- View configurations
- WASM bridge for JavaScript

**Example:**

```rust
use app_core::{Workspace, schema::{TableDefinition, ColumnDefinition, ColumnType}};

let mut workspace = Workspace::new("my-workspace");

// Create a table
let table_def = TableDefinition::new("tasks", "Tasks")
    .with_column(ColumnDefinition::new("title", "Title", ColumnType::Text));

let updates = workspace.create_table(table_def)?;
```

## UI Features

### Entry View

The entry view is the primary interface for viewing and editing individual rows (entries). It provides:

- **Field-based layout**: Fields are rendered in configurable order based on column type
- **Inline editing**: All fields are editable in-place with keyboard navigation
- **Multiple field types**:
  - Text, Number, Boolean, Date
  - Select and MultiSelect dropdowns
  - Reference fields (links to other entries)
  - Document cells (Markdown with live preview)
  - JSON fields for complex data
- **Navigation**: Breadcrumb navigation and back button
- **Rapid creation**: Support for creating multiple entries in sequence (coming soon)

**Routes:**
- `/table/:tableId/entry/:rowId` - View/edit existing entry
- `/table/:tableId/entry/new` - Create new entry

### Document Cells

Document cells support collaborative rich text using Markdown:

- **Edit/Preview toggle**: Switch between editing source and viewing rendered output
- **Markdown shortcuts**: Headers, bold, italic, inline code, links
- **Live rendering**: Preview updates as you type
- **Lazy loading**: Document content is only loaded when viewing the entry (not in table views)

Future: Will be upgraded to Typst for templated documents and PDF generation.

## Architecture Highlights

### Everything Is Tables

The fundamental data model is **tables of LWW cells**:

- A **cell** is identified by `(table_id, row_id, column_id)`
- **Schema** is a table
- **Views** are a table
- **Table definitions** are a table

This means **one event type, one merge strategy, one code path**.

### Single Room per Workspace

All workspace data lives in a single Matrix room for privacy:

- The homeserver sees only room metadata, not structure
- All encrypted blobs in one stream
- Prevents metadata leakage about workspace structure

### Order-Based Bumping

Every write bumps the stalest cell, bounding the lookback window to approximately the number of cells in the table.

**Benefits:**
- Active tables stay compact
- Inactive tables don't need bumping
- No coordination required
- No special event types

## Troubleshooting

### Disk Space Issues (Nix)

If you encounter "build failure may have been caused by lack of free disk space":

```bash
# Check disk space
df -h /

# Run Nix garbage collection to free space
nix-collect-garbage -d

# For more aggressive cleanup (deletes old generations)
nix-collect-garbage -d --delete-old

# Check Nix store size
du -sh /nix/store
```

### WASM Build Fails

If `wasm-pack build` fails:

```bash
# Ensure WASM target is installed
rustup target add wasm32-unknown-unknown

# Reinstall wasm-pack
cargo install wasm-pack --force

# Try building with verbose output
wasm-pack build --verbose crates/app-core --target web
```

### UI Build Issues

```bash
# Clear node_modules and reinstall
cd ui
rm -rf node_modules package-lock.json
npm install

# Clear build cache
rm -rf dist
```

### Rust Compilation Errors

```bash
# Update Rust
rustup update

# Clean and rebuild
cargo clean
cargo build
```

## Deployment

### Building for Production

```bash
# Build optimized WASM modules
wasm-pack build crates/app-core --target web --out-dir ../../ui/src/wasm --release

# Build UI
cd ui
npm run build

# Output will be in ui/dist/
```

### Serving the Application

The built application is a static site that can be served by any web server:

```bash
# Using Python
cd ui/dist
python -m http.server 8000

# Using Node.js serve
npx serve ui/dist

# Using nginx, Apache, etc.
# Configure your web server to serve ui/dist/
```

### Matrix Homeserver

You'll need access to a Matrix homeserver. Options:

1. **Public homeserver**: `matrix.org` (not recommended for production)
2. **Self-hosted Synapse**: https://matrix-org.github.io/synapse/
3. **Self-hosted Conduit**: https://conduit.rs/ (lightweight, Rust-based)
4. **Managed hosting**: Element Matrix Services, Beeper, etc.

## Contributing

This is currently an early-stage project. Contributions are welcome!

### Development Principles

- **Test-driven development**: Write tests first
- **Property-based testing**: Use `proptest` for core logic
- **No panics in libraries**: Use `Result<T, E>` everywhere
- **Graceful degradation**: Handle malformed events without crashing

### Before Submitting

1. Run tests: `cargo test`
2. Format code: `cargo fmt`
3. Run clippy: `cargo clippy`
4. Update documentation if needed

## License

Apache-2.0 (see [LICENSE](./LICENSE))

## Status & Roadmap

Current state lives in **[STATUS.md](./STATUS.md)**; the prioritized backlog is
**[TODO.md](./TODO.md)** (the single source of truth for outstanding work).
Non-obvious design decisions are recorded in **[docs/adr/](./docs/adr/)**.

## Resources

- [Architecture Document](./architecture.md) - Detailed design decisions
- [UX and Features](./docs/UX_AND_FEATURES.md) - Complete product vision and feature specifications
- [Matrix Protocol](https://matrix.org/) - The underlying protocol
- [Matrix Rust SDK](https://github.com/matrix-org/matrix-rust-sdk)
- [Megolm Encryption](https://gitlab.matrix.org/matrix-org/olm/-/blob/master/docs/megolm.md)

## Acknowledgments

Built on the shoulders of giants:

- The Matrix protocol and community
- The Rust Matrix SDK team
- The Rust and WebAssembly communities

---

**Status**: Working prototype — see [STATUS.md](./STATUS.md)

The core architecture is implemented end to end: encrypted Matrix sync with
full key management (cross-signing, key backup, recovery, device
verification), LWW convergence on a hybrid logical clock, order-based
compaction, and a multi-view UI — validated by unit, property, Conduit
integration, and two-browser end-to-end tests. Not yet production-ready; see
[TODO.md](./TODO.md) for what stands between here and real data.
