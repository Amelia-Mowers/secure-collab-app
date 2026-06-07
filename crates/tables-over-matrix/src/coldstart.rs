//! Cold start logic for materializing tables from Matrix room history.

use crate::cell::CellUpdate;
use crate::table::Table;
use std::collections::HashMap;

/// Result of a cold start materialization.
#[derive(Debug)]
pub struct ColdStartResult {
    /// Materialized tables indexed by table_id
    pub tables: HashMap<String, Table>,
    /// Number of events processed
    pub events_processed: usize,
    /// Number of events skipped (malformed, etc.)
    pub events_skipped: usize,
}

/// Materialize tables from a full set of timeline cell updates.
///
/// Convenience wrapper over [`TimelinePaginator`] that processes every event as
/// a single batch — the two share **one** materialization engine, so they can't
/// drift apart.
///
/// Materialized **values are order-independent**: every event is applied with
/// LWW resolution (`Table::apply_update`), so the result is the same regardless
/// of the order events are supplied in. The `events_processed` /
/// `events_skipped` counters are an informational dedup count and are most
/// meaningful for newest-first (Matrix backward-pagination) input — see
/// [`TimelinePaginator`].
pub fn materialize_from_timeline(events: Vec<CellUpdate>) -> ColdStartResult {
    let mut paginator = TimelinePaginator::new();
    paginator.process_batch(events);
    paginator.finalize()
}

/// Estimates the required lookback window for a table.
/// With proper bumping, this should be approximately equal to the number of cells.
pub fn estimate_lookback_window(table: &Table) -> usize {
    // With perfect bumping, lookback = cell count
    // Add a small buffer for concurrent writes
    (table.cell_count() as f64 * 1.2).ceil() as usize
}

/// Represents a paginated timeline fetch for incremental cold start.
pub struct TimelinePaginator {
    /// Cells we've already seen (to detect when we can stop)
    seen_cells: HashMap<(String, String, String), u64>,
    /// Tables being materialized
    tables: HashMap<String, Table>,
    /// Total events processed
    events_processed: usize,
    /// Total events skipped
    events_skipped: usize,
}

impl TimelinePaginator {
    pub fn new() -> Self {
        Self {
            seen_cells: HashMap::new(),
            tables: HashMap::new(),
            events_processed: 0,
            events_skipped: 0,
        }
    }

    /// Process a batch of events from the timeline (newest-first, as produced by
    /// Matrix backward pagination).
    ///
    /// Every event is applied with LWW resolution, so materialized **values are
    /// order-independent**. The seen-cell tracking serves two newest-first
    /// purposes only: the `events_processed`/`events_skipped` dedup counters,
    /// and the early-stop signal (the return value). Returns `true` while new
    /// cells are still being discovered; once a batch reveals no new cells the
    /// caller may stop paginating, because under newest-first pagination every
    /// cell's most recent value has already been seen.
    pub fn process_batch(&mut self, events: Vec<CellUpdate>) -> bool {
        let initial_size = self.seen_cells.len();

        for event in events {
            let cell_key = (
                event.table_id.clone(),
                event.row_id.clone(),
                event.column_id.clone(),
            );
            let timestamp = event.timestamp;
            let table_id = event.table_id.clone();

            // Always apply via LWW — correctness does not depend on order.
            self.tables
                .entry(table_id.clone())
                .or_insert_with(|| Table::new(table_id))
                .apply_update(event);

            // First-seen tracking drives the dedup counters and the early-stop.
            match self.seen_cells.entry(cell_key) {
                std::collections::hash_map::Entry::Vacant(slot) => {
                    slot.insert(timestamp);
                    self.events_processed += 1;
                }
                std::collections::hash_map::Entry::Occupied(_) => {
                    self.events_skipped += 1;
                }
            }
        }

        // Continue while still discovering new cells.
        self.seen_cells.len() > initial_size
    }

    /// Finalize and return the cold start result.
    pub fn finalize(self) -> ColdStartResult {
        ColdStartResult {
            tables: self.tables,
            events_processed: self.events_processed,
            events_skipped: self.events_skipped,
        }
    }

    /// Get current progress information.
    pub fn progress(&self) -> (usize, usize) {
        (self.events_processed, self.events_skipped)
    }
}

impl Default for TimelinePaginator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_materialize_from_timeline() {
        let events = vec![
            CellUpdate::new("table1", "row1", "col1", json!("newest"), 300),
            CellUpdate::new("table1", "row1", "col2", json!("value2"), 200),
            CellUpdate::new("table1", "row1", "col1", json!("older"), 100),
            CellUpdate::new("table1", "row2", "col1", json!("value3"), 150),
        ];

        let result = materialize_from_timeline(events);

        assert_eq!(result.tables.len(), 1);
        assert_eq!(result.events_processed, 3);
        assert_eq!(result.events_skipped, 1);

        let table = result.tables.get("table1").unwrap();
        assert_eq!(table.get_value("row1", "col1"), Some(&json!("newest")));
        assert_eq!(table.get_value("row1", "col2"), Some(&json!("value2")));
        assert_eq!(table.get_value("row2", "col1"), Some(&json!("value3")));
    }

    #[test]
    fn test_multiple_tables() {
        let events = vec![
            CellUpdate::new("table1", "row1", "col1", json!("a"), 100),
            CellUpdate::new("table2", "row1", "col1", json!("b"), 100),
            CellUpdate::new("table1", "row2", "col1", json!("c"), 100),
        ];

        let result = materialize_from_timeline(events);

        assert_eq!(result.tables.len(), 2);
        assert!(result.tables.contains_key("table1"));
        assert!(result.tables.contains_key("table2"));
    }

    #[test]
    fn test_paginator_incremental_processing() {
        let mut paginator = TimelinePaginator::new();

        // First batch
        let batch1 = vec![
            CellUpdate::new("table1", "row1", "col1", json!("a"), 300),
            CellUpdate::new("table1", "row1", "col2", json!("b"), 200),
        ];

        let should_continue = paginator.process_batch(batch1);
        assert!(should_continue); // Discovered new cells

        // Second batch with some duplicates
        let batch2 = vec![
            CellUpdate::new("table1", "row1", "col1", json!("old"), 100), // Duplicate
            CellUpdate::new("table1", "row2", "col1", json!("c"), 150),   // New
        ];

        let should_continue = paginator.process_batch(batch2);
        assert!(should_continue); // Still discovering new cells

        // Third batch with only duplicates
        let batch3 = vec![
            CellUpdate::new("table1", "row1", "col1", json!("older"), 50),
            CellUpdate::new("table1", "row1", "col2", json!("older"), 50),
        ];

        let should_continue = paginator.process_batch(batch3);
        assert!(!should_continue); // No new cells discovered

        let result = paginator.finalize();
        assert_eq!(result.events_processed, 3);
        assert_eq!(result.events_skipped, 3);
    }

    #[test]
    fn test_materialize_is_order_independent() {
        // Same events, fed newest-first vs oldest-first, must materialize the
        // same values (the unified engine applies LWW, not first-seen-wins).
        let events = || {
            vec![
                CellUpdate::new("t", "r1", "c", json!("old"), 100),
                CellUpdate::new("t", "r1", "c", json!("new"), 200),
                CellUpdate::new("t", "r2", "c", json!("x"), 150),
            ]
        };

        let oldest_first = materialize_from_timeline(events());
        let newest_first = materialize_from_timeline({
            let mut v = events();
            v.reverse();
            v
        });

        for result in [&oldest_first, &newest_first] {
            let table = result.tables.get("t").unwrap();
            assert_eq!(table.get_value("r1", "c"), Some(&json!("new")));
            assert_eq!(table.get_value("r2", "c"), Some(&json!("x")));
        }
    }
}
