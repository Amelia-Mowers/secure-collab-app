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

// Use wee_alloc as the global allocator in WASM builds
// wee_alloc is optimized for code size and works well with moderate allocations
#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

pub mod bridge;
pub mod schema;
pub mod views;
pub mod workspace;

// Re-export main types
pub use schema::{ColumnDefinition, ColumnType, SchemaManager, TableDefinition};
pub use views::{
    CalendarConfig, FilterConfig, FilterOperator, KanbanConfig, SortConfig, SortDirection,
    TaskListConfig, ViewConfig, ViewManager, ViewType,
};
pub use workspace::Workspace;

#[cfg(feature = "matrix")]
pub use workspace::WorkspaceHandle;

// Re-export bridge for WASM
#[cfg(target_arch = "wasm32")]
pub use bridge::{WasmWorkspace, init_panic_hook, init_tracing};

/// Error types for the app-core library.
/// Uses static strings to avoid allocations in WASM.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Table not found")]
    TableNotFound,

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
