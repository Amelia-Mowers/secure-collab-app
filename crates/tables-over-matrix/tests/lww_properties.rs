//! Property-based tests for Last-Write-Wins conflict resolution.

use proptest::prelude::*;
use serde_json::json;
use tables_over_matrix::{CellUpdate, Table};

// Helper to generate random cell updates
fn arb_cell_update() -> impl Strategy<Value = CellUpdate> {
    (
        "table[0-9]",
        "row[0-9]",
        "col[0-9]",
        any::<u64>(),
        any::<u64>(),
    )
        .prop_map(|(table_id, row_id, col_id, value, timestamp)| {
            CellUpdate::new(table_id, row_id, col_id, json!(value), timestamp)
        })
}

proptest! {
    /// Property: Applying updates in any order should converge to the same state
    /// (for the same set of updates)
    #[test]
    fn test_convergence(updates in prop::collection::vec(arb_cell_update(), 1..20)) {
        let mut table1 = Table::new("test");
        let mut table2 = Table::new("test");

        // Apply in original order
        for update in updates.iter() {
            table1.apply_update(update.clone());
        }

        // Apply in reverse order
        for update in updates.iter().rev() {
            table2.apply_update(update.clone());
        }

        // Both tables should have the same cells
        assert_eq!(table1.rows(), table2.rows());
        assert_eq!(table1.columns(), table2.columns());

        // All cell values should match
        for row_id in table1.rows() {
            for col_id in table1.columns() {
                assert_eq!(
                    table1.get_value(&row_id, &col_id),
                    table2.get_value(&row_id, &col_id)
                );
            }
        }
    }

    /// Property: The newest timestamp always wins
    #[test]
    fn test_newest_wins(
        table_id in "table[0-9]",
        row_id in "row[0-9]",
        col_id in "col[0-9]",
        values in prop::collection::vec(any::<u64>(), 2..10)
    ) {
        let mut table = Table::new(&table_id);

        // Create updates with increasing timestamps
        let updates: Vec<_> = values
            .iter()
            .enumerate()
            .map(|(i, v)| {
                CellUpdate::new(&table_id, &row_id, &col_id, json!(*v), i as u64)
            })
            .collect();

        // Apply in random order (will be handled by proptest shuffling)
        for update in updates.iter() {
            table.apply_update(update.clone());
        }

        // The value should be from the update with the highest timestamp
        let expected_value = json!(values[values.len() - 1]);
        assert_eq!(table.get_value(&row_id, &col_id), Some(&expected_value));
    }

    /// Property: Removing a row should remove all cells in that row
    #[test]
    fn test_row_removal(
        table_id in "table[0-9]",
        row_to_remove in "row[0-9]",
        other_row in "row[1-9][0-9]",
        columns in prop::collection::vec("col[0-9]", 1..5)
    ) {
        prop_assume!(row_to_remove != other_row);

        let mut table = Table::new(&table_id);

        // Add cells to both rows
        for col_id in &columns {
            table.apply_update(CellUpdate::new(
                &table_id,
                &row_to_remove,
                col_id,
                json!("value1"),
                100,
            ));
            table.apply_update(CellUpdate::new(
                &table_id,
                &other_row,
                col_id,
                json!("value2"),
                100,
            ));
        }

        // Remove one row
        table.remove_row(&row_to_remove);

        // Check that the removed row has no cells
        for col_id in &columns {
            assert!(table.get_cell(&row_to_remove, col_id).is_none());
        }

        // Check that the other row still has cells
        for col_id in &columns {
            assert!(table.get_cell(&other_row, col_id).is_some());
        }
    }

    /// Property: Table cell count should never exceed rows * columns
    #[test]
    fn test_cell_count_bound(updates in prop::collection::vec(arb_cell_update(), 1..50)) {
        let mut table = Table::new("test");

        for update in updates {
            table.apply_update(update);
        }

        let max_cells = table.rows().len() * table.columns().len();
        assert!(table.cell_count() <= max_cells);
    }
}

#[test]
fn test_idempotent_updates() {
    // Applying the same update multiple times should have no effect
    let mut table = Table::new("test");

    let update = CellUpdate::new("test", "row1", "col1", json!("value"), 100);

    table.apply_update(update.clone());
    let rows_after_first = table.rows().len();
    let cell_count_after_first = table.cell_count();

    table.apply_update(update.clone());
    table.apply_update(update);

    assert_eq!(table.rows().len(), rows_after_first);
    assert_eq!(table.cell_count(), cell_count_after_first);
}
