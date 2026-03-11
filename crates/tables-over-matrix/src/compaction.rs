//! Compaction logic using order-based bumping to bound lookback windows.

use crate::cell::{CellId, CellUpdate};
use crate::table::Table;
use std::collections::HashMap;

/// Manages bump tracking and selection for multiple tables.
pub struct CompactionManager {
    /// Track the last bump timestamp for each cell across all tables
    last_bump: HashMap<CellId, u64>,
}

impl CompactionManager {
    pub fn new() -> Self {
        Self {
            last_bump: HashMap::new(),
        }
    }

    /// Select the stalest cell from a table that needs to be bumped.
    /// Returns None if the table is empty.
    pub fn select_bump_candidate(&self, table: &Table) -> Option<CellId> {
        table.get_stalest_cell()
    }

    /// Create a bump update for a given cell.
    /// A bump is just a regular cell update with the current value and a new timestamp.
    pub fn create_bump_update(
        &mut self,
        table: &Table,
        cell_id: &CellId,
        new_timestamp: u64,
    ) -> Option<CellUpdate> {
        let cell = table.get_cell(&cell_id.row_id, &cell_id.column_id)?;

        // Record this bump
        self.last_bump.insert(cell_id.clone(), new_timestamp);

        Some(CellUpdate::new(
            &cell_id.table_id,
            &cell_id.row_id,
            &cell_id.column_id,
            cell.value.clone(),
            new_timestamp,
        ))
    }

    /// Helper to generate a bump alongside a user update.
    /// When a user makes a write, we also bump the stalest cell in that table.
    pub fn generate_updates_with_bump(
        &mut self,
        table: &Table,
        user_update: CellUpdate,
        mut timestamp_generator: impl FnMut() -> u64,
    ) -> Vec<CellUpdate> {
        let mut updates = vec![user_update];

        // Select the stalest cell to bump
        if let Some(cell_id) = self.select_bump_candidate(table) {
            // Don't bump the cell we're already updating
            let user_cell_id = updates[0].cell_id();
            if cell_id != user_cell_id {
                if let Some(bump) = self.create_bump_update(table, &cell_id, timestamp_generator()) {
                    updates.push(bump);
                }
            }
        }

        updates
    }

    /// Calculate the effective lookback window size for a table.
    /// This is the number of events we'd need to scan to materialize the table from cold start.
    pub fn calculate_lookback_window(&self, table: &Table) -> usize {
        // In theory, with perfect bumping, the lookback is bounded by the number of cells
        // In practice, it may be slightly larger due to concurrent writes
        table.cell_count()
    }
}

impl Default for CompactionManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_select_bump_candidate() {
        let mut table = Table::new("test_table");
        let manager = CompactionManager::new();

        // Empty table should return None
        assert!(manager.select_bump_candidate(&table).is_none());

        // Add some cells
        table.apply_update(CellUpdate::new("test_table", "row1", "col1", json!("a"), 100));
        table.apply_update(CellUpdate::new("test_table", "row1", "col2", json!("b"), 200));
        table.apply_update(CellUpdate::new("test_table", "row2", "col1", json!("c"), 50));

        // Should select the stalest cell (row2, col1 with timestamp 50)
        let candidate = manager.select_bump_candidate(&table).unwrap();
        assert_eq!(candidate.row_id, "row2");
        assert_eq!(candidate.column_id, "col1");
    }

    #[test]
    fn test_create_bump_update() {
        let mut table = Table::new("test_table");
        let mut manager = CompactionManager::new();

        table.apply_update(CellUpdate::new("test_table", "row1", "col1", json!("value"), 100));

        let cell_id = CellId::new("test_table", "row1", "col1");
        let bump = manager.create_bump_update(&table, &cell_id, 500).unwrap();

        assert_eq!(bump.table_id, "test_table");
        assert_eq!(bump.row_id, "row1");
        assert_eq!(bump.column_id, "col1");
        assert_eq!(bump.value, json!("value"));
        assert_eq!(bump.timestamp, 500);
    }

    #[test]
    fn test_generate_updates_with_bump() {
        let mut table = Table::new("test_table");
        let mut manager = CompactionManager::new();

        // Add initial cells
        table.apply_update(CellUpdate::new("test_table", "row1", "col1", json!("a"), 100));
        table.apply_update(CellUpdate::new("test_table", "row1", "col2", json!("b"), 200));

        let user_update = CellUpdate::new("test_table", "row2", "col1", json!("new"), 300);

        let mut timestamp = 300;
        let updates = manager.generate_updates_with_bump(&table, user_update, || {
            timestamp += 1;
            timestamp
        });

        // Should have user update + bump update
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].row_id, "row2");
        assert_eq!(updates[0].value, json!("new"));

        // Bump should be for the stalest cell (row1, col1)
        assert_eq!(updates[1].row_id, "row1");
        assert_eq!(updates[1].column_id, "col1");
        assert_eq!(updates[1].value, json!("a"));
    }

    #[test]
    fn test_no_self_bump() {
        let mut table = Table::new("test_table");
        let mut manager = CompactionManager::new();

        // Single cell table
        table.apply_update(CellUpdate::new("test_table", "row1", "col1", json!("a"), 100));

        // Try to update the only cell
        let user_update = CellUpdate::new("test_table", "row1", "col1", json!("b"), 200);

        let mut timestamp = 200;
        let updates = manager.generate_updates_with_bump(&table, user_update, || {
            timestamp += 1;
            timestamp
        });

        // Should only have the user update, no bump (can't bump itself)
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].value, json!("b"));
    }
}
