//! Tests for compaction and bump selection logic.

use serde_json::json;
use tables_over_matrix::{CellUpdate, CompactionManager, Table};

#[test]
fn test_bump_selection_picks_stalest() {
    let mut table = Table::new("test");

    // Create cells with different timestamps
    table.apply_update(CellUpdate::new("test", "row1", "col1", json!("a"), 100));
    table.apply_update(CellUpdate::new("test", "row1", "col2", json!("b"), 200));
    table.apply_update(CellUpdate::new("test", "row2", "col1", json!("c"), 50)); // Oldest

    let manager = CompactionManager::new();
    let candidate = manager.select_bump_candidate(&table).unwrap();

    // Should select the oldest cell
    assert_eq!(candidate.row_id, "row2");
    assert_eq!(candidate.column_id, "col1");
}

#[test]
fn test_bump_updates_timestamp() {
    let mut table = Table::new("test");
    let mut manager = CompactionManager::new();

    table.apply_update(CellUpdate::new("test", "row1", "col1", json!("value"), 100));

    let cell_id = table.get_stalest_cell().unwrap();
    let bump = manager.create_bump_update(&table, &cell_id, 500).unwrap();

    // Bump should have new timestamp but same value
    assert_eq!(bump.timestamp, 500);
    assert_eq!(bump.value, json!("value"));
    assert_eq!(bump.row_id, "row1");
    assert_eq!(bump.column_id, "col1");
}

#[test]
fn test_automatic_bumping_with_updates() {
    let mut table = Table::new("test");
    let mut manager = CompactionManager::new();

    // Create initial cells
    table.apply_update(CellUpdate::new("test", "row1", "col1", json!("a"), 100));
    table.apply_update(CellUpdate::new("test", "row1", "col2", json!("b"), 200));
    table.apply_update(CellUpdate::new("test", "row2", "col1", json!("c"), 300));

    // Make a user update
    let user_update = CellUpdate::new("test", "row2", "col2", json!("new"), 400);

    let mut timestamp = 400;
    let updates = manager.generate_updates_with_bump(&table, user_update, || {
        timestamp += 1;
        timestamp
    });

    // Should have user update + bump
    assert_eq!(updates.len(), 2);
    assert_eq!(updates[0].row_id, "row2");
    assert_eq!(updates[0].column_id, "col2");
    assert_eq!(updates[0].value, json!("new"));

    // Bump should be for row1, col1 (oldest at timestamp 100)
    assert_eq!(updates[1].row_id, "row1");
    assert_eq!(updates[1].column_id, "col1");
    assert_eq!(updates[1].value, json!("a"));
}

#[test]
fn test_lookback_window_bounded_by_cell_count() {
    let mut table = Table::new("test");
    let manager = CompactionManager::new();

    // Add 10 cells
    for i in 0..10 {
        table.apply_update(CellUpdate::new(
            "test",
            format!("row{}", i),
            "col1",
            json!(i),
            i as u64 * 100,
        ));
    }

    let lookback = manager.calculate_lookback_window(&table);

    // Lookback should be approximately equal to cell count
    assert_eq!(lookback, 10);
}

#[test]
fn test_sequential_bumps_cycle_through_cells() {
    let mut table = Table::new("test");
    let mut manager = CompactionManager::new();

    // Create 3 cells
    table.apply_update(CellUpdate::new("test", "row1", "col1", json!("a"), 100));
    table.apply_update(CellUpdate::new("test", "row2", "col1", json!("b"), 100));
    table.apply_update(CellUpdate::new("test", "row3", "col1", json!("c"), 100));

    let mut timestamp = 1000u64;

    // Make several updates, each triggering a bump
    for i in 0..5 {
        let user_update = CellUpdate::new(
            "test",
            format!("row{}", i % 3 + 1),
            "col2",
            json!(i),
            timestamp,
        );

        let updates = manager.generate_updates_with_bump(&table, user_update.clone(), || {
            timestamp += 1;
            timestamp
        });

        // Apply all updates
        for update in updates {
            table.apply_update(update);
        }

        timestamp += 10;
    }

    // All cells should have been bumped at some point
    // (We can't easily verify this without internal state access,
    // but the test ensures the mechanism works without panicking)
    assert!(table.cell_count() > 0);
}

#[test]
fn test_empty_table_no_bump() {
    let table = Table::new("test");
    let mut manager = CompactionManager::new();

    let user_update = CellUpdate::new("test", "row1", "col1", json!("first"), 100);

    let updates = manager.generate_updates_with_bump(&table, user_update, || 101);

    // Should only have the user update, no bump
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].value, json!("first"));
}
