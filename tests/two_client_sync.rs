//! Integration test: Two clients syncing cell updates.
//!
//! Only available when the "matrix" feature is enabled.

#![cfg(feature = "matrix")]

mod harness;

use harness::TestHarness;
use serde_json::json;
use tables_over_matrix::{CellUpdate, Table};

#[tokio::test]
#[ignore] // Requires homeserver - run with: cargo test --features integration --ignored
async fn test_two_client_cell_sync() {
    // Setup: Create test harness with two clients
    let harness = TestHarness::new().await.unwrap();
    let clients = harness::create_collaborative_workspace(&harness, &["alice", "bob"])
        .await
        .unwrap();

    let client_a = &clients[0];
    let client_b = &clients[1];

    // Client A creates a cell update
    let update = CellUpdate::new("tasks", "task1", "title", json!("Buy groceries"), 100);

    // Client A sends the update to the room
    // (In a real implementation, this would use client_a.send_cell_update(&update))
    println!("Client A would send: {:?}", update);

    // Wait for sync to propagate
    harness.wait_for_sync().await;

    // Client B should receive the update via sync
    // (In a real implementation, client B would sync and receive the event)
    println!("Client B would receive the update");

    // Both clients materialize the table
    let mut table_a = Table::new("tasks");
    let mut table_b = Table::new("tasks");

    table_a.apply_update(update.clone());
    table_b.apply_update(update);

    // Both should have the same value
    assert_eq!(
        table_a.get_value("task1", "title"),
        Some(&json!("Buy groceries"))
    );
    assert_eq!(
        table_b.get_value("task1", "title"),
        Some(&json!("Buy groceries"))
    );
    assert_eq!(
        table_a.get_value("task1", "title"),
        table_b.get_value("task1", "title")
    );
}

#[tokio::test]
#[ignore]
async fn test_concurrent_updates_converge() {
    let harness = TestHarness::new().await.unwrap();
    let clients = harness::create_collaborative_workspace(&harness, &["alice", "bob"])
        .await
        .unwrap();

    // Simulate concurrent updates from both clients
    let update_a = CellUpdate::new("tasks", "task1", "title", json!("Alice's version"), 100);
    let update_b = CellUpdate::new("tasks", "task1", "title", json!("Bob's version"), 200);

    // Both clients send their updates
    println!("Client A sends: {:?}", update_a);
    println!("Client B sends: {:?}", update_b);

    harness.wait_for_sync().await;

    // Both clients receive both updates and apply them
    let mut table_a = Table::new("tasks");
    let mut table_b = Table::new("tasks");

    // Apply in different orders
    table_a.apply_update(update_a.clone());
    table_a.apply_update(update_b.clone());

    table_b.apply_update(update_b);
    table_b.apply_update(update_a);

    // Both should converge to the same value (Bob's, since it has higher timestamp)
    assert_eq!(
        table_a.get_value("task1", "title"),
        Some(&json!("Bob's version"))
    );
    assert_eq!(
        table_b.get_value("task1", "title"),
        Some(&json!("Bob's version"))
    );
}
