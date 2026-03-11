//! Integration test: Cold start from room history.
//!
//! Only available when the "matrix" feature is enabled.

#![cfg(feature = "matrix")]

mod harness;

use harness::TestHarness;
use serde_json::json;
use tables_over_matrix::{materialize_from_timeline, CellUpdate};

#[tokio::test]
#[ignore] // Requires homeserver
async fn test_cold_start_from_room_timeline() {
    let harness = TestHarness::new().await.unwrap();
    let clients = harness::create_collaborative_workspace(&harness, &["alice", "bob"])
        .await
        .unwrap();

    // Client A populates the workspace with several updates
    let updates = vec![
        CellUpdate::new("tasks", "task1", "title", json!("First task"), 100),
        CellUpdate::new("tasks", "task1", "status", json!("todo"), 101),
        CellUpdate::new("tasks", "task2", "title", json!("Second task"), 102),
        CellUpdate::new("tasks", "task2", "status", json!("done"), 103),
        // Update an existing cell
        CellUpdate::new("tasks", "task1", "status", json!("in-progress"), 104),
    ];

    for update in &updates {
        println!("Client A sends: {:?}", update);
        // In a real implementation: clients[0].send_cell_update(update).await.unwrap();
    }

    harness.wait_for_sync().await;

    // Client B (new client) joins the room and performs cold start
    println!("Client B performs cold start from room history");

    // Simulate receiving events in reverse chronological order (newest first)
    let timeline_events = updates.into_iter().rev().collect();

    let result = materialize_from_timeline(timeline_events);

    // Verify the materialized table has the correct state
    let table = result.tables.get("tasks").unwrap();

    assert_eq!(table.rows().len(), 2);
    assert_eq!(
        table.get_value("task1", "title"),
        Some(&json!("First task"))
    );
    assert_eq!(
        table.get_value("task1", "status"),
        Some(&json!("in-progress")) // Latest update
    );
    assert_eq!(
        table.get_value("task2", "title"),
        Some(&json!("Second task"))
    );
    assert_eq!(table.get_value("task2", "status"), Some(&json!("done")));

    // Verify efficiency: one duplicate was skipped
    assert_eq!(result.events_skipped, 1); // The old status update for task1
    assert_eq!(result.events_processed, 4);
}

#[tokio::test]
#[ignore]
async fn test_cold_start_with_bumping() {
    let harness = TestHarness::new().await.unwrap();
    let _clients = harness::create_collaborative_workspace(&harness, &["alice"])
        .await
        .unwrap();

    // Simulate a history with automatic bumps
    let events = vec![
        // Recent events (newest first)
        CellUpdate::new("tasks", "task1", "title", json!("Task 1"), 1000), // User update
        CellUpdate::new("tasks", "task2", "status", json!("todo"), 999),   // Bump
        CellUpdate::new("tasks", "task2", "title", json!("Task 2"), 900),  // User update
        CellUpdate::new("tasks", "task1", "status", json!("done"), 899),   // Bump
        // Older events that should be skipped
        CellUpdate::new("tasks", "task1", "title", json!("Old title"), 100),
        CellUpdate::new("tasks", "task2", "title", json!("Old task 2"), 50),
    ];

    let result = materialize_from_timeline(events);

    let table = result.tables.get("tasks").unwrap();

    // Should have the newest values
    assert_eq!(table.get_value("task1", "title"), Some(&json!("Task 1")));
    assert_eq!(table.get_value("task2", "title"), Some(&json!("Task 2")));

    // Old values should have been skipped
    assert!(result.events_skipped > 0);

    println!(
        "Cold start efficiency: processed {} events, skipped {} events",
        result.events_processed, result.events_skipped
    );
}
