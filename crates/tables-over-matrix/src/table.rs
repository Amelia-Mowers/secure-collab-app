//! Table materialization and management.

use crate::cell::{Cell, CellId, CellUpdate};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Reserved column id used as a **row-level tombstone**. A row whose
/// [`ROW_DELETED_COLUMN`] cell resolves to a truthy value is treated as deleted
/// and is excluded from materialization ([`Table::get_all_rows`]).
///
/// Deletion is therefore an ordinary LWW cell write rather than an in-memory
/// `remove_row`: it syncs over Matrix, survives a cold-start replay, and
/// propagates to other devices like any other cell. The row's data cells are
/// left in place and decay naturally (see `architecture.md` —
/// "Deletion as Natural Decay"). A concurrent edit to one of the row's *data*
/// cells does not resurrect it; only a newer `_deleted = false` write does.
///
/// The leading underscore marks it as a reserved field (cf. `_row_id`); column
/// ids derived from user-supplied names are slugified and never start with `_`.
pub const ROW_DELETED_COLUMN: &str = "_deleted";

/// Reserved column id holding a row's **manual-ordering key** — a
/// fractional-index string. [`Table::get_all_rows`] returns rows sorted by this
/// key (rows that have one first, in key order; unkeyed rows after, by id), so
/// reordering a row is a single LWW cell write with no neighbour rewrites and
/// every view that reads `get_all_rows` shows the same order.
pub const ROW_ORDER_COLUMN: &str = "_order";

/// Reserved row-level fields that are not user data and must not surface as
/// columns in materialized output.
fn is_reserved_column(column_id: &str) -> bool {
    column_id == ROW_DELETED_COLUMN || column_id == ROW_ORDER_COLUMN
}

/// A materialized table containing LWW-resolved cells.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Table {
    pub id: String,
    /// Cells indexed by (row_id, column_id)
    cells: HashMap<(String, String), Cell>,
    /// Track which rows exist
    rows: HashSet<String>,
    /// Track which columns exist
    columns: HashSet<String>,
    /// Metadata about each cell's last update timestamp for bump tracking
    cell_ages: HashMap<(String, String), u64>,
}

impl Table {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            cells: HashMap::new(),
            rows: HashSet::new(),
            columns: HashSet::new(),
            cell_ages: HashMap::new(),
        }
    }

    /// Apply a cell update to the table using LWW resolution.
    pub fn apply_update(&mut self, update: CellUpdate) {
        // Extract values before consuming update
        let timestamp = update.timestamp;

        // Convert to cell by consuming update (avoids 3 string clones + 1 value clone)
        let cell = update.into_cell();

        // Build key from cell's id (reuse the strings we already own)
        let row_id = &cell.id.row_id;
        let column_id = &cell.id.column_id;

        // Only allocate for HashSets if not already present
        if !self.rows.contains(row_id) {
            self.rows.insert(row_id.clone());
        }
        if !self.columns.contains(column_id) {
            self.columns.insert(column_id.clone());
        }

        let key = (row_id.clone(), column_id.clone());

        // Apply LWW resolution
        match self.cells.get(&key) {
            Some(existing) => {
                if cell.wins_over(existing) {
                    // Reuse key for both inserts - cell_ages gets a clone, cells gets ownership
                    self.cell_ages.insert(key.clone(), timestamp);
                    self.cells.insert(key, cell);
                }
                // If existing cell wins, drop everything (no inserts needed)
            }
            None => {
                // New cell - insert into both maps
                self.cell_ages.insert(key.clone(), timestamp);
                self.cells.insert(key, cell);
            }
        }
    }

    /// Get a cell value by row and column ID.
    pub fn get_cell(&self, row_id: &str, column_id: &str) -> Option<&Cell> {
        self.cells.get(&(row_id.to_string(), column_id.to_string()))
    }

    /// Get a cell's value as JSON.
    pub fn get_value(&self, row_id: &str, column_id: &str) -> Option<&serde_json::Value> {
        self.get_cell(row_id, column_id).map(|cell| &cell.value)
    }

    /// Get all rows in the table.
    pub fn rows(&self) -> Vec<String> {
        let mut rows: Vec<_> = self.rows.iter().cloned().collect();
        rows.sort();
        rows
    }

    /// Get all columns in the table.
    pub fn columns(&self) -> Vec<String> {
        let mut cols: Vec<_> = self.columns.iter().cloned().collect();
        cols.sort();
        cols
    }

    /// Get a complete row as a map of column_id -> value. Reserved fields
    /// (`_deleted`, `_order`) are control metadata and are excluded.
    pub fn get_row(&self, row_id: &str) -> IndexMap<String, serde_json::Value> {
        self.get_row_excluding_stale(row_id, &HashMap::new())
    }

    /// Like [`get_row`](Self::get_row), but also drops any cell for a column
    /// listed in `cutoffs` whose timestamp is at or before that column's cutoff.
    /// Used to hide values that predate a column's deletion when the column is
    /// later re-created (the column starts blank rather than resurrecting old
    /// data — the data cells aren't tombstoned under the decay model, so they're
    /// filtered at read time instead).
    fn get_row_excluding_stale(
        &self,
        row_id: &str,
        cutoffs: &HashMap<String, u64>,
    ) -> IndexMap<String, serde_json::Value> {
        let mut row = IndexMap::new();
        for column_id in &self.columns {
            if is_reserved_column(column_id) {
                continue;
            }
            if let Some(cell) = self.get_cell(row_id, column_id) {
                if cutoffs.get(column_id).is_some_and(|&c| cell.timestamp <= c) {
                    continue; // stale: written at/before the column was deleted
                }
                row.insert(column_id.clone(), cell.value.clone());
            }
        }
        row
    }

    /// Get all rows as a structured dataset, excluding any row that carries a
    /// truthy [`ROW_DELETED_COLUMN`] tombstone and sorted by the manual-ordering
    /// key ([`ROW_ORDER_COLUMN`]): rows with a key first (in key order, ties by
    /// id), then unkeyed rows by id.
    pub fn get_all_rows(&self) -> Vec<IndexMap<String, serde_json::Value>> {
        self.get_all_rows_excluding_stale(&HashMap::new())
    }

    /// Like [`get_all_rows`](Self::get_all_rows), but drops cells that predate a
    /// column's deletion cutoff (see [`get_row_excluding_stale`]). `cutoffs` maps
    /// `column_id -> deleted_at` for columns that were deleted (and possibly
    /// re-created); columns absent from the map are unfiltered.
    pub fn get_all_rows_excluding_stale(
        &self,
        cutoffs: &HashMap<String, u64>,
    ) -> Vec<IndexMap<String, serde_json::Value>> {
        let mut ids: Vec<String> = self
            .rows()
            .into_iter()
            .filter(|row_id| !self.is_row_deleted(row_id))
            .collect();
        ids.sort_by(|a, b| match (self.row_order(a), self.row_order(b)) {
            (Some(ka), Some(kb)) => ka.cmp(&kb).then_with(|| a.cmp(b)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.cmp(b),
        });
        ids.into_iter()
            .map(|row_id| {
                let mut row = self.get_row_excluding_stale(&row_id, cutoffs);
                row.insert("_row_id".to_string(), serde_json::json!(row_id));
                row
            })
            .collect()
    }

    /// Whether `row_id` carries a truthy row-level tombstone
    /// ([`ROW_DELETED_COLUMN`]). Such rows are hidden from materialization but
    /// their underlying cells remain (and decay naturally).
    pub fn is_row_deleted(&self, row_id: &str) -> bool {
        self.get_value(row_id, ROW_DELETED_COLUMN)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    /// Whether `row_id` has any cell written strictly after `ts`.
    ///
    /// Used by the table-level deletion cutoff: when a table id is deleted and
    /// later re-created, its pre-deletion rows must vanish entirely rather than
    /// linger as empty rows (a per-column value cutoff hides the *values* but
    /// the row itself still exists). A row whose every cell predates the table's
    /// `deleted_at` is dropped; one with a post-deletion cell survives. This is
    /// the row-level analogue of [`get_row_excluding_stale`]'s column cutoff.
    pub fn row_has_cell_newer_than(&self, row_id: &str, ts: u64) -> bool {
        self.cells
            .iter()
            .any(|((r, _), cell)| r == row_id && cell.timestamp > ts)
    }

    /// A row's manual-ordering key ([`ROW_ORDER_COLUMN`]), if set to a string.
    pub fn row_order(&self, row_id: &str) -> Option<String> {
        self.get_value(row_id, ROW_ORDER_COLUMN)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    /// Remove a row from the table (for deletion).
    pub fn remove_row(&mut self, row_id: &str) {
        self.rows.remove(row_id);
        self.cells.retain(|(r, _), _| r != row_id);
        self.cell_ages.retain(|(r, _), _| r != row_id);
    }

    /// Remove a column from the table (for deletion).
    pub fn remove_column(&mut self, column_id: &str) {
        self.columns.remove(column_id);
        self.cells.retain(|(_, c), _| c != column_id);
        self.cell_ages.retain(|(_, c), _| c != column_id);
    }

    /// Get the stalest cell (oldest timestamp) for bump selection.
    pub fn get_stalest_cell(&self) -> Option<CellId> {
        self.cell_ages
            .iter()
            .min_by_key(|(_, &timestamp)| timestamp)
            .map(|((row_id, column_id), _)| CellId::new(&self.id, row_id, column_id))
    }

    /// The stalest cell that should still be kept alive by bumping — i.e.
    /// excluding cells that are meant to decay. Without this, the bump (which
    /// picks the *stalest* cell) would refresh exactly the dead pre-deletion
    /// cells, defeating the decay model and the deletion cutoff (it would push a
    /// deleted column's old value past its `deleted_at`, resurrecting it if the
    /// column is re-created).
    ///
    /// Excluded: a deleted row's data cells (its [`ROW_DELETED_COLUMN`] tombstone
    /// stays eligible, so cold start still learns of the deletion), and any cell
    /// at or before a column's `cutoffs` deletion timestamp.
    pub fn get_stalest_bumpable_cell(&self, cutoffs: &HashMap<String, u64>) -> Option<CellId> {
        self.cell_ages
            .iter()
            .filter(|((row_id, column_id), &ts)| {
                // Keep a deleted row's tombstone bumpable; drop its data cells.
                if column_id != ROW_DELETED_COLUMN && self.is_row_deleted(row_id) {
                    return false;
                }
                // Drop cells at/before a column's deletion cutoff.
                match cutoffs.get(column_id.as_str()) {
                    Some(&cutoff) => ts > cutoff,
                    None => true,
                }
            })
            .min_by_key(|(_, &timestamp)| timestamp)
            .map(|((row_id, column_id), _)| CellId::new(&self.id, row_id, column_id))
    }

    /// The `n` stalest bumpable cells, oldest first.
    ///
    /// Same eligibility rules as [`get_stalest_bumpable_cell`], which this
    /// generalises — that one is exactly `n = 1`. Sorting the eligible set once
    /// and taking a prefix keeps this O(cells log cells) for the whole batch;
    /// calling the singular selector `n` times with a growing exclusion set
    /// would be O(n·cells) and re-scan the same cells repeatedly.
    ///
    /// Used by the batched compaction path: refreshing many cells in ONE event
    /// is what shortens the cold-start walk, because the walk costs ~7 ms per
    /// EVENT and only ~0.14 ms per cell (ADR 0006 M1).
    pub fn get_stalest_bumpable_cells(
        &self,
        cutoffs: &HashMap<String, u64>,
        n: usize,
    ) -> Vec<CellId> {
        if n == 0 {
            return Vec::new();
        }
        let mut eligible: Vec<_> = self
            .cell_ages
            .iter()
            .filter(|((row_id, column_id), &ts)| {
                // Keep a deleted row's tombstone bumpable; drop its data cells.
                if column_id != ROW_DELETED_COLUMN && self.is_row_deleted(row_id) {
                    return false;
                }
                // Drop cells at/before a column's deletion cutoff.
                match cutoffs.get(column_id.as_str()) {
                    Some(&cutoff) => ts > cutoff,
                    None => true,
                }
            })
            .collect();
        eligible.sort_by_key(|(_, &timestamp)| timestamp);
        eligible
            .into_iter()
            .take(n)
            .map(|((row_id, column_id), _)| CellId::new(&self.id, row_id, column_id))
            .collect()
    }

    /// Get the number of cells in the table.
    pub fn cell_count(&self) -> usize {
        self.cells.len()
    }

    /// All currently-materialized (winning) cells, for snapshotting. Each cell
    /// carries its LWW timestamp and server-timestamp tiebreaker, so replaying
    /// them via [`apply_update`](Self::apply_update) reconstructs identical
    /// state. The cell map is keyed by `(row, column)` tuples — which JSON can't
    /// represent as map keys — so snapshots persist this flat list instead.
    pub fn export_cells(&self) -> Vec<Cell> {
        self.cells.values().cloned().collect()
    }

    /// Check if the table is empty.
    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_table_creation() {
        let table = Table::new("test_table");
        assert_eq!(table.id, "test_table");
        assert!(table.is_empty());
    }

    #[test]
    fn test_apply_update() {
        let mut table = Table::new("test_table");
        let update = CellUpdate::new("test_table", "row1", "col1", json!("value1"), 100);

        table.apply_update(update);

        assert_eq!(table.cell_count(), 1);
        assert_eq!(table.get_value("row1", "col1"), Some(&json!("value1")));
    }

    #[test]
    fn test_lww_resolution_in_table() {
        let mut table = Table::new("test_table");

        // Apply older update first
        let update1 = CellUpdate::new("test_table", "row1", "col1", json!("old"), 100);
        table.apply_update(update1);

        // Apply newer update
        let update2 = CellUpdate::new("test_table", "row1", "col1", json!("new"), 200);
        table.apply_update(update2);

        assert_eq!(table.get_value("row1", "col1"), Some(&json!("new")));

        // Apply even older update - should be ignored
        let update3 = CellUpdate::new("test_table", "row1", "col1", json!("oldest"), 50);
        table.apply_update(update3);

        assert_eq!(table.get_value("row1", "col1"), Some(&json!("new")));
    }

    #[test]
    fn test_get_row() {
        let mut table = Table::new("test_table");

        table.apply_update(CellUpdate::new(
            "test_table",
            "row1",
            "col1",
            json!("a"),
            100,
        ));
        table.apply_update(CellUpdate::new(
            "test_table",
            "row1",
            "col2",
            json!("b"),
            100,
        ));
        table.apply_update(CellUpdate::new(
            "test_table",
            "row2",
            "col1",
            json!("c"),
            100,
        ));

        let row = table.get_row("row1");
        assert_eq!(row.len(), 2);
        assert_eq!(row.get("col1"), Some(&json!("a")));
        assert_eq!(row.get("col2"), Some(&json!("b")));
    }

    #[test]
    fn test_remove_row() {
        let mut table = Table::new("test_table");

        table.apply_update(CellUpdate::new(
            "test_table",
            "row1",
            "col1",
            json!("a"),
            100,
        ));
        table.apply_update(CellUpdate::new(
            "test_table",
            "row2",
            "col1",
            json!("b"),
            100,
        ));

        table.remove_row("row1");

        assert_eq!(table.cell_count(), 1);
        assert_eq!(table.rows().len(), 1);
        assert!(table.get_cell("row1", "col1").is_none());
        assert!(table.get_cell("row2", "col1").is_some());
    }

    #[test]
    fn test_row_tombstone_excluded_from_materialization() {
        let mut table = Table::new("t");
        table.apply_update(CellUpdate::new("t", "r1", "title", json!("Keep"), 100));
        table.apply_update(CellUpdate::new("t", "r2", "title", json!("Doomed"), 100));
        assert_eq!(table.get_all_rows().len(), 2);

        // Tombstone r2.
        table.apply_update(CellUpdate::new(
            "t",
            "r2",
            ROW_DELETED_COLUMN,
            json!(true),
            200,
        ));
        assert!(table.is_row_deleted("r2"));
        assert!(!table.is_row_deleted("r1"));

        let rows = table.get_all_rows();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("_row_id"), Some(&json!("r1")));
        // The reserved tombstone field never leaks into materialized output.
        assert!(rows.iter().all(|r| !r.contains_key(ROW_DELETED_COLUMN)));
    }

    #[test]
    fn test_data_edit_does_not_resurrect_tombstoned_row() {
        // A deletion dominates concurrent edits to the row's *data* cells: those
        // edits don't touch `_deleted`, so the row stays hidden.
        let mut table = Table::new("t");
        table.apply_update(CellUpdate::new("t", "r1", "title", json!("Doomed"), 100));
        table.apply_update(CellUpdate::new(
            "t",
            "r1",
            ROW_DELETED_COLUMN,
            json!(true),
            200,
        ));
        table.apply_update(CellUpdate::new(
            "t",
            "r1",
            "title",
            json!("Edited later"),
            300,
        ));

        assert!(table.is_row_deleted("r1"));
        assert!(table.get_all_rows().is_empty());
    }

    #[test]
    fn test_undelete_via_newer_tombstone_clear() {
        // Explicitly clearing the tombstone with a newer write restores the row
        // (LWW on the `_deleted` cell).
        let mut table = Table::new("t");
        table.apply_update(CellUpdate::new("t", "r1", "title", json!("Row"), 100));
        table.apply_update(CellUpdate::new(
            "t",
            "r1",
            ROW_DELETED_COLUMN,
            json!(true),
            200,
        ));
        assert!(table.get_all_rows().is_empty());

        table.apply_update(CellUpdate::new(
            "t",
            "r1",
            ROW_DELETED_COLUMN,
            json!(false),
            300,
        ));
        assert_eq!(table.get_all_rows().len(), 1);
        assert!(!table.is_row_deleted("r1"));
    }

    #[test]
    fn test_stale_tombstone_loses_to_newer_clear_order_independent() {
        // An older tombstone must never win over a newer un-delete, regardless of
        // apply order (mirrors test_lww_resolution_in_table for the `_deleted` cell).
        let del = CellUpdate::new("t", "r1", ROW_DELETED_COLUMN, json!(true), 100);
        let undel = CellUpdate::new("t", "r1", ROW_DELETED_COLUMN, json!(false), 200);

        let mut a = Table::new("t");
        a.apply_update(del.clone());
        a.apply_update(undel.clone());
        assert!(!a.is_row_deleted("r1"));

        let mut b = Table::new("t");
        b.apply_update(undel);
        b.apply_update(del);
        assert!(!b.is_row_deleted("r1"));
    }

    fn row_ids(table: &Table) -> Vec<String> {
        table
            .get_all_rows()
            .into_iter()
            .map(|r| r.get("_row_id").unwrap().as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn test_get_all_rows_sorted_by_order_key() {
        let mut table = Table::new("t");
        table.apply_update(CellUpdate::new("t", "a", "title", json!("A"), 1));
        table.apply_update(CellUpdate::new("t", "b", "title", json!("B"), 1));
        table.apply_update(CellUpdate::new("t", "c", "title", json!("C"), 1));
        // Keys place c < a < b (lexicographically).
        table.apply_update(CellUpdate::new("t", "a", ROW_ORDER_COLUMN, json!("V"), 2));
        table.apply_update(CellUpdate::new("t", "b", ROW_ORDER_COLUMN, json!("l"), 2));
        table.apply_update(CellUpdate::new("t", "c", ROW_ORDER_COLUMN, json!("G"), 2));

        assert_eq!(row_ids(&table), vec!["c", "a", "b"]);
        // The reserved _order field is never exposed as a column.
        assert!(table
            .get_all_rows()
            .iter()
            .all(|r| !r.contains_key(ROW_ORDER_COLUMN)));
    }

    #[test]
    fn test_keyed_rows_sort_before_unkeyed() {
        let mut table = Table::new("t");
        table.apply_update(CellUpdate::new("t", "z", "title", json!("Z"), 1)); // unkeyed
        table.apply_update(CellUpdate::new("t", "a", "title", json!("A"), 1)); // unkeyed
        table.apply_update(CellUpdate::new("t", "m", "title", json!("M"), 1));
        table.apply_update(CellUpdate::new("t", "m", ROW_ORDER_COLUMN, json!("V"), 2)); // keyed

        // Keyed row first, then the unkeyed rows by id.
        assert_eq!(row_ids(&table), vec!["m", "a", "z"]);
    }

    #[test]
    fn test_no_order_keys_preserves_id_order() {
        let mut table = Table::new("t");
        table.apply_update(CellUpdate::new("t", "b", "x", json!(1), 1));
        table.apply_update(CellUpdate::new("t", "a", "x", json!(1), 1));
        assert_eq!(row_ids(&table), vec!["a", "b"]);
    }

    #[test]
    fn test_get_all_rows_excludes_cells_at_or_before_cutoff() {
        let mut table = Table::new("t");
        // Two cells in the same column, one before and one after the cutoff.
        table.apply_update(CellUpdate::new("t", "r1", "col", json!("old"), 100));
        table.apply_update(CellUpdate::new("t", "r2", "col", json!("new"), 300));
        // A cell in an UNlisted column is never filtered.
        table.apply_update(CellUpdate::new("t", "r1", "other", json!("keep"), 100));

        let mut cutoffs = std::collections::HashMap::new();
        cutoffs.insert("col".to_string(), 200u64);
        let rows = table.get_all_rows_excluding_stale(&cutoffs);

        let r1 = rows.iter().find(|r| r["_row_id"] == json!("r1")).unwrap();
        let r2 = rows.iter().find(|r| r["_row_id"] == json!("r2")).unwrap();
        // r1.col (ts 100 ≤ 200) is filtered out; r2.col (ts 300 > 200) stays.
        assert!(r1.get("col").is_none());
        assert_eq!(r2.get("col"), Some(&json!("new")));
        // The unlisted column is untouched.
        assert_eq!(r1.get("other"), Some(&json!("keep")));

        // With no cutoffs, get_all_rows returns everything.
        let all = table.get_all_rows();
        let r1_all = all.iter().find(|r| r["_row_id"] == json!("r1")).unwrap();
        assert_eq!(r1_all.get("col"), Some(&json!("old")));
    }

    #[test]
    fn test_get_stalest_bumpable_cell_skips_dead_cells() {
        let mut table = Table::new("t");
        // Past a column cutoff (staler than the live cell).
        table.apply_update(CellUpdate::new("t", "r1", "dead", json!("x"), 10));
        table.apply_update(CellUpdate::new("t", "r1", "live", json!("y"), 20));
        // A deleted row whose data cell is the stalest of all (ts 5).
        table.apply_update(CellUpdate::new("t", "gone", "title", json!("z"), 5));
        table.apply_update(CellUpdate::new(
            "t",
            "gone",
            ROW_DELETED_COLUMN,
            json!(true),
            30,
        ));

        let mut cutoffs = std::collections::HashMap::new();
        cutoffs.insert("dead".to_string(), 15u64);

        // Plain stalest is the deleted row's data cell (ts 5).
        assert_eq!(table.get_stalest_cell().unwrap().row_id, "gone");

        // Bumpable stalest skips the deleted row's data cell and the past-cutoff
        // 'dead' cell; the next live cell is r1/live (ts 20). The tombstone
        // (_deleted, ts 30) stays eligible but is newer.
        let c = table.get_stalest_bumpable_cell(&cutoffs).unwrap();
        assert_eq!((c.row_id.as_str(), c.column_id.as_str()), ("r1", "live"));
    }

    #[test]
    fn test_stalest_cell() {
        let mut table = Table::new("test_table");

        table.apply_update(CellUpdate::new(
            "test_table",
            "row1",
            "col1",
            json!("a"),
            100,
        ));
        table.apply_update(CellUpdate::new(
            "test_table",
            "row1",
            "col2",
            json!("b"),
            200,
        ));
        table.apply_update(CellUpdate::new(
            "test_table",
            "row2",
            "col1",
            json!("c"),
            50,
        ));

        let stalest = table.get_stalest_cell().unwrap();
        assert_eq!(stalest.row_id, "row2");
        assert_eq!(stalest.column_id, "col1");
    }

    #[test]
    fn test_lww_tiebreak_by_server_timestamp_is_order_independent() {
        // Two writes with the SAME logical timestamp but different server
        // timestamps must converge to the same winner regardless of the order
        // they are applied. Without the tiebreaker, a logical-clock tie resolves
        // to "last applied locally", which diverges between clients.
        // See ARCHITECTURE_REVIEW.md §4.1.
        let a = CellUpdate::new("t", "r", "c", json!("A"), 5).with_server_timestamp(100);
        let b = CellUpdate::new("t", "r", "c", json!("B"), 5).with_server_timestamp(200);

        let mut t1 = Table::new("t");
        t1.apply_update(a.clone());
        t1.apply_update(b.clone());

        let mut t2 = Table::new("t");
        t2.apply_update(b);
        t2.apply_update(a);

        // Higher server timestamp (B) wins in BOTH application orders.
        assert_eq!(t1.get_value("r", "c"), Some(&json!("B")));
        assert_eq!(t2.get_value("r", "c"), Some(&json!("B")));
    }
}
