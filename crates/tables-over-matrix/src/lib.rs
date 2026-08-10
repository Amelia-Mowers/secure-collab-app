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
pub mod invite;
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
    request_openid_token, reset_recovery, reset_recovery_with_passphrase, CellBatchEventContent,
    CellUpdateEventContent, MatrixClient, ReceivedCellUpdate, SessionInfo, CELL_BATCH_EVENT_TYPE,
    CELL_UPDATE_EVENT_TYPE,
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

/// Skew tolerance for the incremental cold-start walk (issue 48f042ba).
/// `/messages` follows the server's STREAM order, which can disagree with
/// `origin_server_ts` by persister skew when Synapse runs workers / stream
/// writers. The margin bounds how much disagreement the walk tolerates before
/// concluding it has really passed the snapshot marker.
pub const REORDER_GRACE_MS: u64 = 30_000;

/// Whether the incremental cold-start walk has convincingly passed the
/// snapshot marker and may stop paginating (issue 48f042ba).
///
/// `page_oldest` is the oldest parseable `origin_server_ts` on the page just
/// processed; `stop_before` is the snapshot marker. The old rule — abandon the
/// entire walk at the FIRST event nominally older than the marker — assumed
/// stream order and `origin_server_ts` agree. Under workers they need not: one
/// reordered event then truncated the walk, every event deeper in the stream
/// was skipped, and because the running marker had already advanced past them,
/// no later incremental start would ever fetch them — a permanent,
/// self-sealing hole (8 events lost in prod on 2026-07-25). Now a page must
/// trail the marker by more than [`REORDER_GRACE_MS`] before the walk stops:
/// an event is lost only if the two orders disagree by over the margin.
///
/// A full gather (`fast_path == false`) never stops early, and a page with no
/// parseable timestamps cannot justify stopping.
/// Has compaction already covered every live cell, so the walk can stop?
///
/// Three conditions, and the middle one is the whole reason this is a named
/// function rather than an `if`:
///
/// * the page added no cell we had not already seen — the signal that recent
///   events already carry a current value for everything live;
/// * the page was fully READABLE. A page yields no new cells when compaction
///   covered them, and equally when we could not decrypt a single event on it.
///   Those are indistinguishable by cell count, and stopping on the second
///   truncates the walk silently: the workspace comes up with holes and nothing
///   anywhere reports an error. Undecryptable history is a reason to keep
///   walking, not evidence of completeness;
/// * we have seen something at all, so an empty first page cannot end a walk
///   before it starts.
///
/// A full gather (`stop_when_covered == false`) never stops early — the
/// integrity check compares a complete re-gather against local state, and a
/// shortcut would make it agree with itself by construction.
pub fn coverage_reached(
    stop_when_covered: bool,
    page_new_cells: usize,
    page_undecryptable: usize,
    seen_any_cell: bool,
) -> bool {
    stop_when_covered && page_new_cells == 0 && page_undecryptable == 0 && seen_any_cell
}

pub fn backfill_caught_up(fast_path: bool, page_oldest: Option<u64>, stop_before: u64) -> bool {
    fast_path && page_oldest.is_some_and(|t| t.saturating_add(REORDER_GRACE_MS) < stop_before)
}

#[cfg(test)]
mod walk_rules {
    use super::*;

    // ── coverage_reached ────────────────────────────────────────────────────

    #[test]
    fn a_covered_page_stops_the_walk() {
        assert!(coverage_reached(true, 0, 0, true));
    }

    #[test]
    fn an_unreadable_page_does_not_count_as_covered() {
        // THE point of the rule. A page yields no new cells when compaction
        // covered them, and equally when not one event on it could be
        // decrypted. Stopping on the second brings the workspace up with holes
        // and reports nothing — the failure this guard exists to prevent, and
        // the reason the condition is not simply `page_new_cells == 0`.
        assert!(!coverage_reached(true, 0, 1, true));
        assert!(!coverage_reached(true, 0, 500, true));
    }

    #[test]
    fn a_page_that_added_cells_never_stops_the_walk() {
        assert!(!coverage_reached(true, 1, 0, true));
        // Not even when it also had unreadable events on it.
        assert!(!coverage_reached(true, 1, 1, true));
    }

    #[test]
    fn an_empty_first_page_cannot_end_a_walk_before_it_starts() {
        assert!(!coverage_reached(true, 0, 0, false));
    }

    #[test]
    fn a_full_gather_never_takes_the_shortcut() {
        // The integrity check compares a complete re-gather against local
        // state; stopping early would make it agree with itself by
        // construction and prove nothing.
        assert!(!coverage_reached(false, 0, 0, true));
    }

    // ── backfill_caught_up (the REORDER_GRACE_MS boundary) ──────────────────

    #[test]
    fn a_page_well_past_the_marker_stops_an_incremental_walk() {
        let marker = 1_000_000;
        assert!(backfill_caught_up(
            true,
            Some(marker - REORDER_GRACE_MS - 1),
            marker
        ));
    }

    #[test]
    fn the_grace_margin_is_exclusive_at_its_boundary() {
        // Exactly one margin behind the marker must NOT stop the walk. This is
        // the line that lost 8 events in production on 2026-07-25: stream order
        // and origin_server_ts disagree under Synapse workers, and an
        // off-by-one here truncates the walk permanently — the running marker
        // advances past the skipped events, so no later start refetches them.
        let marker = 1_000_000;
        assert!(!backfill_caught_up(
            true,
            Some(marker - REORDER_GRACE_MS),
            marker
        ));
        assert!(!backfill_caught_up(true, Some(marker), marker));
    }

    #[test]
    fn a_full_gather_never_stops_at_the_marker() {
        assert!(!backfill_caught_up(false, Some(0), u64::MAX));
    }

    #[test]
    fn a_page_with_no_readable_timestamp_cannot_justify_stopping() {
        assert!(!backfill_caught_up(true, None, u64::MAX));
    }

    #[test]
    fn an_early_epoch_page_does_not_underflow_into_stopping() {
        // saturating_add, not add: a timestamp near zero with the margin added
        // must stay comparable rather than wrapping.
        assert!(backfill_caught_up(true, Some(0), u64::MAX));
        assert!(!backfill_caught_up(true, Some(u64::MAX), 0));
    }
}

/// What a history walk actually did — returned rather than only logged,
/// because "the bounded walk saves work" is a claim that should be asserted
/// in a test, not inferred from wall-clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WalkStats {
    /// Timeline events fetched and replayed.
    pub events: usize,
    /// Round-trips to /messages — the part that dominates cold start.
    pub pages: usize,
    /// Distinct cells the walk resolved.
    pub cells: usize,
    /// Why it ended: "covered", "reached marker", "start of room", ...
    pub stopped: &'static str,
    /// Events the walk could not decrypt.
    ///
    /// Not a diagnostic: a caller that materializes state while this is
    /// non-zero is showing the user a workspace with holes in it. Better to be
    /// correct and delayed than fast and wrong — keys usually arrive shortly
    /// after a burst of writes, so the fix is to wait and retry, not to render.
    pub undecryptable: usize,
}

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
