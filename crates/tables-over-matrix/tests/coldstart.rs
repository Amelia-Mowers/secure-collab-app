//! Tests for cold start materialization from event timeline.

use serde_json::json;
use tables_over_matrix::{materialize_from_timeline, CellUpdate, TimelinePaginator};

#[test]
fn test_materialize_picks_newest_values() {
    // Events in reverse chronological order (newest first)
    let events = vec![
        CellUpdate::new("table1", "row1", "col1", json!("newest"), 500),
        CellUpdate::new("table1", "row1", "col2", json!("value2"), 400),
        CellUpdate::new("table1", "row1", "col1", json!("older"), 300),
        CellUpdate::new("table1", "row1", "col1", json!("oldest"), 100),
    ];

    let result = materialize_from_timeline(events);

    assert_eq!(result.tables.len(), 1);

    let table = result.tables.get("table1").unwrap();
    assert_eq!(table.get_value("row1", "col1"), Some(&json!("newest")));
    assert_eq!(table.get_value("row1", "col2"), Some(&json!("value2")));

    // Should have processed 2 events and skipped 2
    assert_eq!(result.events_processed, 2);
    assert_eq!(result.events_skipped, 2);
}

#[test]
fn test_materialize_multiple_tables() {
    let events = vec![
        CellUpdate::new("users", "user1", "name", json!("Alice"), 100),
        CellUpdate::new("tasks", "task1", "title", json!("Task 1"), 100),
        CellUpdate::new("users", "user2", "name", json!("Bob"), 100),
        CellUpdate::new("tasks", "task2", "title", json!("Task 2"), 100),
    ];

    let result = materialize_from_timeline(events);

    assert_eq!(result.tables.len(), 2);
    assert!(result.tables.contains_key("users"));
    assert!(result.tables.contains_key("tasks"));

    let users = result.tables.get("users").unwrap();
    assert_eq!(users.rows().len(), 2);

    let tasks = result.tables.get("tasks").unwrap();
    assert_eq!(tasks.rows().len(), 2);
}

#[test]
fn test_materialize_empty_timeline() {
    let events = vec![];
    let result = materialize_from_timeline(events);

    assert_eq!(result.tables.len(), 0);
    assert_eq!(result.events_processed, 0);
    assert_eq!(result.events_skipped, 0);
}

#[test]
fn test_paginator_incremental_loading() {
    let mut paginator = TimelinePaginator::new();

    // First batch - all new cells
    let batch1 = vec![
        CellUpdate::new("table1", "row1", "col1", json!("a"), 300),
        CellUpdate::new("table1", "row1", "col2", json!("b"), 300),
    ];

    let should_continue = paginator.process_batch(batch1);
    assert!(should_continue); // New cells discovered

    // Second batch - mix of new and old
    let batch2 = vec![
        CellUpdate::new("table1", "row1", "col1", json!("old"), 100), // Duplicate
        CellUpdate::new("table1", "row2", "col1", json!("c"), 200),   // New
    ];

    let should_continue = paginator.process_batch(batch2);
    assert!(should_continue); // Still discovering new cells

    // Third batch - all duplicates
    let batch3 = vec![
        CellUpdate::new("table1", "row1", "col1", json!("older"), 50),
        CellUpdate::new("table1", "row1", "col2", json!("older"), 50),
    ];

    let should_continue = paginator.process_batch(batch3);
    assert!(!should_continue); // No new cells, can stop

    let result = paginator.finalize();
    assert_eq!(result.events_processed, 3);
    assert_eq!(result.events_skipped, 3);
}

#[test]
fn test_paginator_tracks_progress() {
    let mut paginator = TimelinePaginator::new();

    let batch = vec![
        CellUpdate::new("table1", "row1", "col1", json!("a"), 100),
        CellUpdate::new("table1", "row2", "col1", json!("b"), 100),
    ];

    paginator.process_batch(batch);

    let (processed, skipped) = paginator.progress();
    assert_eq!(processed, 2);
    assert_eq!(skipped, 0);
}

#[test]
fn test_out_of_order_events() {
    // Events in random order
    let events = vec![
        CellUpdate::new("table1", "row1", "col1", json!("v3"), 300),
        CellUpdate::new("table1", "row1", "col1", json!("v1"), 100),
        CellUpdate::new("table1", "row1", "col1", json!("v2"), 200),
        CellUpdate::new("table1", "row1", "col1", json!("v4"), 400),
    ];

    let result = materialize_from_timeline(events);

    let table = result.tables.get("table1").unwrap();

    // Should still pick the newest based on timestamp
    assert_eq!(table.get_value("row1", "col1"), Some(&json!("v4")));
}

#[test]
fn test_sparse_table_materialization() {
    // Events for a sparse table (not all cells filled)
    let events = vec![
        CellUpdate::new("table1", "row1", "col1", json!("a"), 100),
        CellUpdate::new("table1", "row2", "col2", json!("b"), 100),
        CellUpdate::new("table1", "row3", "col3", json!("c"), 100),
    ];

    let result = materialize_from_timeline(events);

    let table = result.tables.get("table1").unwrap();

    // Should have 3 rows and 3 columns
    assert_eq!(table.rows().len(), 3);
    assert_eq!(table.columns().len(), 3);

    // But only 3 cells (sparse)
    assert_eq!(table.cell_count(), 3);

    // Check sparse access
    assert_eq!(table.get_value("row1", "col1"), Some(&json!("a")));
    assert_eq!(table.get_value("row1", "col2"), None);
    assert_eq!(table.get_value("row2", "col1"), None);
    assert_eq!(table.get_value("row2", "col2"), Some(&json!("b")));
}
