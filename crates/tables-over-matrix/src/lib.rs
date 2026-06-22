//! # tables-over-matrix
//!
//! A library for building collaborative, end-to-end encrypted tables using the Matrix protocol.
//!
//! This library implements Last-Write-Wins (LWW) conflict resolution for cells in tables,
//! with automatic compaction through order-based bumping to bound cold-start lookback windows.
//!
//! ## Architecture
//!
//! - **Cell**: The fundamental unit of data, identified by `(table_id, row_id, column_id)`
//! - **Table**: A collection of cells with LWW resolution
//! - **Compaction**: Order-based bumping to keep the lookback window bounded
//! - **Cold Start**: Efficient materialization from Matrix room timeline
//! - **Matrix**: Integration with Matrix SDK for E2E encrypted transport
//!
//! ## Example
//!
//! ```rust,no_run
//! use tables_over_matrix::{Table, CellUpdate};
//! use serde_json::json;
//!
//! let mut table = Table::new("my_table");
//!
//! // Apply a cell update
//! let update = CellUpdate::new("my_table", "row1", "col1", json!("hello"), 100);
//! table.apply_update(update);
//!
//! // Read the value
//! assert_eq!(table.get_value("row1", "col1"), Some(&json!("hello")));
//! ```

pub mod cell;
pub mod coldstart;
pub mod compaction;
pub mod table;

#[cfg(feature = "matrix")]
pub mod matrix;

// Re-export main types
pub use cell::{Cell, CellId, CellUpdate, CELL_UPDATE_VERSION};
pub use coldstart::{materialize_from_timeline, ColdStartResult, TimelinePaginator};
pub use compaction::CompactionManager;
pub use table::{Table, ROW_DELETED_COLUMN, ROW_ORDER_COLUMN};

// Re-export Matrix types only when the matrix feature is enabled
#[cfg(feature = "matrix")]
pub use matrix::{
    default_encryption_settings, enable_recovery, enable_recovery_with_passphrase,
    reset_recovery_with_passphrase, CellBatchEventContent, CellUpdateEventContent, MatrixClient,
    ReceivedCellUpdate, SessionInfo, CELL_BATCH_EVENT_TYPE, CELL_UPDATE_EVENT_TYPE,
};

/// Error types for the library.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Invalid cell update: {0}")]
    InvalidCellUpdate(String),

    #[error("Table not found: {0}")]
    TableNotFound(String),

    #[cfg(feature = "matrix")]
    #[error("Room not found")]
    RoomNotFound,

    #[cfg(feature = "matrix")]
    #[error("Not authenticated")]
    NotAuthenticated,

    #[error("Other error: {0}")]
    Other(#[from] anyhow::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Library version information.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod integration_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_full_workflow() {
        // Create a table
        let mut table = Table::new("test_table");

        // Create some updates
        let updates = vec![
            CellUpdate::new("test_table", "row1", "col1", json!("a"), 100),
            CellUpdate::new("test_table", "row1", "col2", json!("b"), 101),
            CellUpdate::new("test_table", "row2", "col1", json!("c"), 102),
        ];

        // Apply updates
        for update in updates {
            table.apply_update(update);
        }

        // Verify the table state
        assert_eq!(table.cell_count(), 3);
        assert_eq!(table.rows().len(), 2);
        assert_eq!(table.columns().len(), 2);

        // Get a row
        let row1 = table.get_row("row1");
        assert_eq!(row1.len(), 2);
        assert_eq!(row1.get("col1"), Some(&json!("a")));

        // Test compaction
        let manager = CompactionManager::new();
        let bump_candidate = manager.select_bump_candidate(&table).unwrap();
        assert_eq!(bump_candidate.table_id, "test_table");

        let bump = manager
            .create_bump_update(&table, &bump_candidate, 200)
            .unwrap();
        assert_eq!(bump.timestamp, 200);
    }

    #[test]
    fn test_cold_start_simulation() {
        // Simulate a series of events in reverse chronological order (as they'd come from Matrix)
        let events = vec![
            CellUpdate::new("table1", "row1", "col1", json!("newest"), 500),
            CellUpdate::new("table1", "row2", "col1", json!("value"), 400),
            CellUpdate::new("table1", "row1", "col2", json!("data"), 300),
            CellUpdate::new("table1", "row1", "col1", json!("old"), 200), // Should be ignored
            CellUpdate::new("table1", "row3", "col1", json!("value"), 100),
        ];

        let result = materialize_from_timeline(events);

        assert_eq!(result.tables.len(), 1);
        let table = result.tables.get("table1").unwrap();

        // Verify correct values are materialized
        assert_eq!(table.get_value("row1", "col1"), Some(&json!("newest")));
        assert_eq!(table.get_value("row2", "col1"), Some(&json!("value")));
        assert_eq!(table.get_value("row1", "col2"), Some(&json!("data")));

        // One event should have been skipped (the old value for row1/col1)
        assert_eq!(result.events_skipped, 1);
        assert_eq!(result.events_processed, 4);
    }
}
