//! Integration test: Two clients syncing cell updates over Matrix.
//!
//! Requires Conduit homeserver in PATH.
//! Run with: cargo test --features matrix -- --ignored

#![cfg(feature = "matrix")]

mod harness;

use harness::{setup_workspace, TestHarness};
use serde_json::json;
use tables_over_matrix::{CellUpdate, Table};

#[tokio::test]
#[ignore]
async fn test_two_client_cell_sync() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, _room_id) = setup_workspace(&harness, &["alice", "bob"])
        .await
        .unwrap();

    // Client A sends a cell update to the room
    let update = CellUpdate::new("tasks", "task1", "title", json!("Buy groceries"), 100);
    clients[0].send_cell_update(&update).await.unwrap();

    // Wait for sync propagation
    harness.wait_for_sync().await;

    // Client B syncs and should receive the event
    clients[1].sync_once().await.unwrap();

    // Both clients apply the update to their local tables
    let mut table_a = Table::new("tasks");
    let mut table_b = Table::new("tasks");

    table_a.apply_update(update.clone());
    table_b.apply_update(update);

    assert_eq!(
        table_a.get_value("task1", "title"),
        Some(&json!("Buy groceries"))
    );
    assert_eq!(
        table_b.get_value("task1", "title"),
        Some(&json!("Buy groceries"))
    );
}

#[tokio::test]
#[ignore]
async fn test_concurrent_updates_converge() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, _room_id) = setup_workspace(&harness, &["alice", "bob"])
        .await
        .unwrap();

    // Both clients send conflicting updates
    let update_a = CellUpdate::new("tasks", "task1", "title", json!("Alice's version"), 100);
    let update_b = CellUpdate::new("tasks", "task1", "title", json!("Bob's version"), 200);

    clients[0].send_cell_update(&update_a).await.unwrap();
    clients[1].send_cell_update(&update_b).await.unwrap();

    harness.wait_for_sync().await;

    // Both sync
    clients[0].sync_once().await.unwrap();
    clients[1].sync_once().await.unwrap();

    // Apply in different orders — LWW should converge
    let mut table_a = Table::new("tasks");
    let mut table_b = Table::new("tasks");

    table_a.apply_update(update_a.clone());
    table_a.apply_update(update_b.clone());

    table_b.apply_update(update_b);
    table_b.apply_update(update_a);

    // Bob's update wins (higher timestamp)
    assert_eq!(
        table_a.get_value("task1", "title"),
        Some(&json!("Bob's version"))
    );
    assert_eq!(
        table_b.get_value("task1", "title"),
        Some(&json!("Bob's version"))
    );
}

#[tokio::test]
#[ignore]
async fn test_send_multiple_updates() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, _room_id) = setup_workspace(&harness, &["alice"])
        .await
        .unwrap();

    // Send several updates via Matrix
    let updates = vec![
        CellUpdate::new("tasks", "row1", "title", json!("Task 1"), 1),
        CellUpdate::new("tasks", "row1", "status", json!("todo"), 2),
        CellUpdate::new("tasks", "row2", "title", json!("Task 2"), 3),
    ];

    clients[0].send_cell_updates(&updates).await.unwrap();

    // Sync to confirm they were accepted
    clients[0].sync_once().await.unwrap();

    // Materialize locally
    let mut table = Table::new("tasks");
    for u in &updates {
        table.apply_update(u.clone());
    }

    assert_eq!(table.cell_count(), 3);
    assert_eq!(table.get_value("row1", "title"), Some(&json!("Task 1")));
    assert_eq!(table.get_value("row1", "status"), Some(&json!("todo")));
    assert_eq!(table.get_value("row2", "title"), Some(&json!("Task 2")));
}
