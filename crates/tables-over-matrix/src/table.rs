//! Table materialization and management.

use crate::cell::{Cell, CellId, CellUpdate};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

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

    /// Get a complete row as a map of column_id -> value.
    pub fn get_row(&self, row_id: &str) -> IndexMap<String, serde_json::Value> {
        let mut row = IndexMap::new();
        for column_id in &self.columns {
            if let Some(cell) = self.get_cell(row_id, column_id) {
                row.insert(column_id.clone(), cell.value.clone());
            }
        }
        row
    }

    /// Get all rows as a structured dataset.
    pub fn get_all_rows(&self) -> Vec<IndexMap<String, serde_json::Value>> {
        self.rows()
            .iter()
            .map(|row_id| {
                let mut row = self.get_row(row_id);
                row.insert("_row_id".to_string(), serde_json::json!(row_id));
                row
            })
            .collect()
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

    /// Get the number of cells in the table.
    pub fn cell_count(&self) -> usize {
        self.cells.len()
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
