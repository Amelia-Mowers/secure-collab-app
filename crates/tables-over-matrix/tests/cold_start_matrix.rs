//! Integration test: Cold start from room history.
//!
//! Requires Conduit homeserver in PATH.
//! Run with: cargo test --features matrix -- --ignored

#![cfg(feature = "matrix")]

mod harness;

use harness::{setup_workspace, TestHarness};
use serde_json::json;
use tables_over_matrix::{materialize_from_timeline, CellUpdate};

#[tokio::test]
#[ignore]
async fn test_cold_start_from_sent_events() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, _room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    // Alice sends several cell updates to the room
    let updates = vec![
        CellUpdate::new("tasks", "task1", "title", json!("First task"), 100),
        CellUpdate::new("tasks", "task1", "status", json!("todo"), 101),
        CellUpdate::new("tasks", "task2", "title", json!("Second task"), 102),
        CellUpdate::new("tasks", "task2", "status", json!("done"), 103),
        // Overwrite task1 status
        CellUpdate::new("tasks", "task1", "status", json!("in-progress"), 104),
    ];

    for update in &updates {
        clients[0].send_cell_update(update).await.unwrap();
    }

    // Materialize from the ordered list of updates (simulating cold start
    // from the room timeline)
    let result = materialize_from_timeline(updates.clone());

    let table = result.tables.get("tasks").unwrap();
    assert_eq!(table.rows().len(), 2);
    assert_eq!(
        table.get_value("task1", "title"),
        Some(&json!("First task"))
    );
    assert_eq!(
        table.get_value("task1", "status"),
        Some(&json!("in-progress"))
    );
    assert_eq!(
        table.get_value("task2", "title"),
        Some(&json!("Second task"))
    );
    assert_eq!(table.get_value("task2", "status"), Some(&json!("done")));

    // In forward-chronological order, the newer task1.status (ts=104) supersedes
    // the older one (ts=101). Both are "processed" since each was newest at the
    // time it was encountered. events_skipped only increments when an event has
    // a *lower* timestamp than a previously seen event for the same cell.
    assert_eq!(result.events_skipped, 0);
    assert_eq!(result.events_processed, 5);
}

#[tokio::test]
#[ignore]
async fn test_cold_start_with_bumping() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, _room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    // Simulate a history with user updates and compaction bumps
    let events = vec![
        CellUpdate::new("tasks", "task1", "title", json!("Task 1"), 1000),
        CellUpdate::new("tasks", "task2", "status", json!("todo"), 999),
        CellUpdate::new("tasks", "task2", "title", json!("Task 2"), 900),
        CellUpdate::new("tasks", "task1", "status", json!("done"), 899),
        // Older events that should be superseded
        CellUpdate::new("tasks", "task1", "title", json!("Old title"), 100),
        CellUpdate::new("tasks", "task2", "title", json!("Old task 2"), 50),
    ];

    // Send them all to Matrix
    for event in &events {
        clients[0].send_cell_update(event).await.unwrap();
    }

    let result = materialize_from_timeline(events);
    let table = result.tables.get("tasks").unwrap();

    assert_eq!(table.get_value("task1", "title"), Some(&json!("Task 1")));
    assert_eq!(table.get_value("task2", "title"), Some(&json!("Task 2")));
    assert!(result.events_skipped > 0);

    eprintln!(
        "Cold start: processed {} events, skipped {}",
        result.events_processed, result.events_skipped
    );
}
