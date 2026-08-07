//! # app-core
//!
//! Application-specific logic for the secure collaborative workspace.
//!
//! This crate builds on top of `tables-over-matrix` to provide:
//! - Workspace management and lifecycle
//! - System table conventions (schema, views, tables)
//! - View configurations and projections
//! - WASM bridge for JavaScript interop
//!
//! ## Architecture
//!
//! The core abstraction is a **Workspace**, which contains:
//! - User tables (data)
//! - System tables (schema definitions, view configs, table metadata)
//! - Schema manager (interprets system tables)
//! - View manager (manages view configurations)
//! - Compaction manager (handles bumping)
//!
//! ## Example
//!
//! ```rust,no_run
//! use app_core::{Workspace, schema::{TableDefinition, ColumnDefinition, ColumnType}};
//!
//! let mut workspace = Workspace::new("my-workspace");
//!
//! // Create a table
//! let table_def = TableDefinition::new("tasks", "Tasks")
//!     .with_column(ColumnDefinition::new("title", "Title", ColumnType::Text));
//!
//! let updates = workspace.create_table(table_def).unwrap();
//! ```

// NO custom global allocator. The default (dlmalloc) is used on wasm32.
//
// This was `wee_alloc`, chosen for code size, and it was the production
// out-of-memory bug. wee_alloc does not reuse freed memory: it grows the wasm
// heap monotonically in proportion to how much a program has EVER allocated,
// not to how much it holds. Measured on the no-Matrix demo, `getTableRows` on a
// four-row table grew the heap by ~12.6 KiB per call, dead linear, with no
// plateau across 10,000 calls (35 MiB -> 160 MiB) — while the JSON it returned
// was 933 bytes and the workspace never changed.
//
// wasm linear memory never shrinks, so that growth is permanent, and it ends at
// whichever ceiling `--max-memory` sets: a bare `unreachable` trap with no panic
// message, and a poisoned module. wee_alloc has been unmaintained since 2020
// with this defect open; the wasm ecosystem stopped recommending it for exactly
// this reason.
//
// The cost of dropping it is a few KB of code size in a multi-megabyte module.

pub mod archive;
pub mod filter_eval;
pub mod formula;
pub mod fractional_index;
pub mod history;
pub mod schema;
pub mod snapshot;
pub mod views;
pub mod workspace;

#[cfg(feature = "wasm")]
pub mod bridge;

#[cfg(all(feature = "wasm", feature = "matrix"))]
pub mod bridge_matrix;

/// Wall-clock bound for a sync that is allowed to hang — see the module docs for
/// why matrix-rust-sdk's own request timeout does not apply in the browser.
#[cfg(feature = "matrix")]
pub mod sync_watchdog;

// Re-export main types
pub use archive::{Archive, ArchiveError, ArchiveTable, ImportIssue, FORMAT_VERSION};
pub use formula::{evaluate as evaluate_formula, FormulaError};
pub use history::{HistoryManager, RevertRecord, HISTORY_TABLE_ID};
pub use schema::{ColumnDefinition, ColumnType, SchemaManager, TableDefinition};
pub use snapshot::{WorkspaceSnapshot, SNAPSHOT_VERSION};
pub use views::{
    CalendarConfig, FilterConfig, FilterOperator, KanbanConfig, SortConfig, SortDirection,
    TaskListConfig, ViewConfig, ViewManager, ViewType,
};
pub use workspace::Workspace;

// Re-export bridge for WASM (local-only workspace)
#[cfg(feature = "wasm")]
pub use bridge::{init_panic_hook, init_tracing, WasmWorkspace};

// Re-export Matrix bridge for WASM builds with Matrix enabled
#[cfg(all(feature = "wasm", feature = "matrix"))]
pub use bridge_matrix::{ConnectedWorkspace, MatrixSession};

/// Error types for the app-core library.
/// Uses static strings to avoid allocations in WASM.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Table not found")]
    TableNotFound,

    #[error("A table with that name already exists")]
    TableAlreadyExists,

    #[error("View not found")]
    ViewNotFound,

    #[error("Invalid configuration")]
    InvalidConfiguration,

    #[error("Workspace error")]
    Workspace(String),

    #[error("Tables-over-matrix error")]
    TablesOverMatrix(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Library version information.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version() {
        assert!(!VERSION.is_empty());
    }
}
