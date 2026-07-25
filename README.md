# TideWork

**[tidework.io](https://tidework.io)** — an open-source, end-to-end encrypted, real-time collaborative workspace built on the Matrix protocol. Think Notion or Airtable, but with genuine E2E encryption, federation, and full data sovereignty.

## Features

- **🔐 End-to-End Encrypted**: All data is encrypted using Matrix's Megolm protocol —
  cross-signing, key backup, recovery keys, and SAS device verification included
- **🔑 Passkey Custody**: A WebAuthn passkey with the PRF extension derives the
  secret that keys secure backup, so a biometric tap unlocks your E2EE keys on a
  new device instead of a typed recovery key (kept as break-glass). Existing
  accounts can enroll one without rotating anything
- **🌐 Federated**: Collaborate across different Matrix homeservers
- **📊 Views**: Tables, kanban boards, and card grids, each saveable with its own
  filters, sort, and layout
- **🔎 Filters**: Per-column conditions (type-aware) with dynamic values that
  resolve per-viewer — `is today` for dates, `@me` for people
- **🧩 Column Types**: Text, number, date, checkbox, select/multi-select, Markdown
  documents, JSON, workspace members, and references to rows of another table
- **📝 Entry View**: Full-page interface for viewing and editing a single row
- **🕘 Change History**: Every edit is in the timeline; revert a table to any point
- **🔄 Real-time Sync**: Changes sync instantly across all devices
- **📴 Offline-tolerant Writes**: Unsent edits persist in an encrypted outbox and
  replay on reconnect; the UI locks writes rather than accumulate divergence
- **🏗️ LWW CRDTs**: Last-Write-Wins conflict resolution for seamless collaboration
- **⚡ Efficient Cold Start**: Order-based bumping bounds lookback windows
- **🦀 Rust Core**: High-performance core compiled to WebAssembly — and reused by a
  native [CLI](#the-tidework-cli)

## Architecture

See [architecture.md](./architecture.md) for a detailed architecture overview.

### Three-Layer Stack

1. **`tables-over-matrix`** (Rust): Pure library for LWW cells over Matrix
2. **`app-core`** (Rust): Application-specific logic and WASM bridge
3. **`ui`** (TypeScript/React): Thin view layer

`crates/cli` is a fourth consumer: a native binary that links `app-core`
directly instead of through WASM, so the CLI and the app share one engine.

## Prerequisites

### Using Nix (Recommended)

If you're on NixOS or using Nix, the development environment is fully reproducible:

```bash
# Enter the Nix development shell
nix develop

# If you get disk space errors, run garbage collection first:
nix-collect-garbage -d
```

The Nix shell automatically provides **everything** you need:
- Rust toolchain with WASM target (wasm32-unknown-unknown)
- wasm-pack and wasm-bindgen-cli
- Node.js 20
- Build tools (pkg-config, openssl, sqlite)
- A Synapse homeserver on `PATH`, for the integration and browser tests
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
│   │   └── tests/             # Unit + Synapse integration tests
│   ├── app-core/              # Application logic and WASM bridge
│   │   └── tests/             # Workspace + Matrix integration tests
│   └── cli/                   # `tidework` — native CLI over the same app-core
├── ui/                        # React/TypeScript frontend
│   └── e2e/                   # Two-browser Playwright tests (real WASM + Synapse)
├── billing/                   # Stripe subscription worker (hosted service)
├── infra/                     # Homeserver deployment + healthchecks
├── site/                      # Marketing site (tidework.io)
├── docs/adr/                  # Architecture decision records
├── scripts/                   # Integration-test runner, build helpers
├── flake.nix                  # Nix development environment
└── Cargo.toml                 # Rust workspace manifest
```

`crates/cli` is excluded from `default-members` (it's a native binary in an
otherwise wasm-first workspace), so build it explicitly: `cargo build -p
tidework-cli`.

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

Integration tests run against a real, throwaway **Synapse** homeserver (provided
by the Nix dev shell) and cover two-client sync, encrypted round-trips, cold
start, key backup/recovery, and SAS verification. Synapse rather than something
lighter because it's what production runs (ADR 0002), and because Conduit omits
the invite-time fields the shared-history path depends on:

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

A two-browser Playwright harness drives the **real compiled WASM** against a live
Synapse — covering registration, recovery, SAS verification, collaborator
history-on-invite, and the core single-device product journey (including reload
persistence). A second suite runs the OAuth flow against Synapse+MAS. See
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

## The TideWork CLI

`crates/cli` builds `tidework`, a native client for the same encrypted
workspaces the app serves. It links `app-core` directly rather than through
WASM, so a view selects the same rows in the terminal as it does in the browser
— including dynamic filter values like `is today` and `@me`, which resolve
against whoever is running the command.

```bash
cargo build -p tidework-cli          # not in default-members; build explicitly

tidework login --sso --homeserver https://matrix.tidework.io
tidework workspace list
tidework table show "My Workspace" Tasks --view "Open Issues"
tidework row add "My Workspace" Tasks name="Fix the thing" status=open
tidework column set "My Workspace" Tasks status --options open,closed
```

It builds natively on Windows, macOS, and Linux (SQLite is bundled). Encryption,
key handling, and LWW merge are the same code paths as the app; `--sso` performs
the OAuth/MAS browser sign-in the production homeserver requires.

## UI Features

### Entry View

The entry view is the primary interface for viewing and editing individual rows (entries). It provides:

- **Field-based layout**: Fields are rendered in configurable order based on column type
- **Inline editing**: All fields are editable in-place with keyboard navigation
- **Multiple field types**:
  - Text, Number, Boolean, Date
  - Select and MultiSelect dropdowns
  - Member and Members (people in the workspace room)
  - Reference and References (rows of another table, shown through that table's
    configured display column)
  - Document cells (Markdown with live preview)
  - JSON fields for complex data
- **Navigation**: Breadcrumb navigation and back button

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
# Build the WASM bindings (same command as `make wasm`; --release is the default
# for wasm-pack, and the feature flags are required — see step 3 above)
make wasm

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
3. **Self-hosted Conduit**: https://conduit.rs/ (lightweight, Rust-based — but
   it omits some invite-time fields TideWork's shared-history path uses, so
   parts of collaboration degrade; the test harnesses run Synapse for this
   reason)
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

Current state lives in **[STATUS.md](./STATUS.md)**. Non-obvious design decisions
are recorded in **[docs/adr/](./docs/adr/)**.

The outstanding backlog is no longer a file in this repo — it's the `Issues`
table of the **TideWork PM** workspace on the production homeserver (TideWork
dogfooding TideWork). Read it with the CLI:

```bash
tidework table show "TideWork PM" Issues
```

[TODO.md](./TODO.md) is a pointer to that workspace.

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

**Status**: Deployed and in daily use, still early — see [STATUS.md](./STATUS.md)

The core architecture is implemented end to end: encrypted Matrix sync with full
key management (cross-signing, key backup, recovery, device verification), LWW
convergence on a hybrid logical clock, order-based compaction, a multi-view UI,
and a native CLI — validated by unit, property, Synapse integration, and
two-browser end-to-end tests.

It runs as a hosted service at [tidework.io](https://tidework.io) (Synapse + MAS,
subscriptions via Stripe) and holds real data, including this project's own
backlog. "Early" is about breadth, not stability: the feature surface is
narrower than the products it resembles, and the schema and event formats may
still change in ways that need migration. Self-hosting works — it's Matrix — but
is not yet documented as a supported path.
