//! Integration test: Two clients syncing cell updates over Matrix.
//!
//! Requires Conduit homeserver in PATH.
//! Run with: cargo test --features matrix -- --ignored

#![cfg(feature = "matrix")]

mod harness;

use harness::{setup_workspace, TestHarness};
use serde_json::json;
use tables_over_matrix::{CellUpdate, MatrixClient, Table};

#[tokio::test]
#[ignore]
async fn test_two_client_cell_sync() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, _room_id) = setup_workspace(&harness, &["alice", "bob"]).await.unwrap();

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
    let (clients, _room_id) = setup_workspace(&harness, &["alice", "bob"]).await.unwrap();

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
    let (clients, _room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

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

/// End-to-end receive path (review §4.5): unlike `test_two_client_cell_sync`,
/// which re-applies the same in-memory `CellUpdate`, this materializes Bob's
/// table from his OWN synced room timeline — exercising the real path of
/// `sync` → fetch timeline → `extract_cell_update` → `into_update` →
/// `apply_update`. It also asserts the Matrix `origin_server_ts` is carried
/// into the update as the LWW tiebreaker (the §4.1 plumbing), proving it works
/// against real server-stamped events rather than hand-built ones.
#[tokio::test]
#[ignore]
async fn test_two_client_sync_via_real_timeline() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, _room_id) = setup_workspace(&harness, &["alice", "bob"]).await.unwrap();
    let mut clients = clients.into_iter();
    let alice = clients.next().unwrap();
    let bob = clients.next().unwrap();

    // Alice writes a cell over Matrix.
    let update = CellUpdate::new("tasks", "t1", "title", json!("Hello from Alice"), 100);
    alice.send_cell_update(&update).await.unwrap();

    // Let it propagate, then Bob syncs so the SDK knows the room is current.
    harness.wait_for_sync().await;
    bob.sync_once().await.unwrap();

    // Bob materializes from his own server-side timeline (the real receive path).
    let room = bob.get_room().unwrap();
    let response = room
        .messages(matrix_sdk::room::MessagesOptions::backward())
        .await
        .unwrap();

    let mut table = Table::new("tasks");
    let mut received = 0;
    for event in &response.chunk {
        if let Ok(json_str) = serde_json::to_string(event.raw().json()) {
            if let Some(rx) = MatrixClient::extract_cell_update(&json_str) {
                let upd = rx.into_update();
                // The server timestamp must be attached as the LWW tiebreaker.
                assert!(
                    upd.server_timestamp.is_some(),
                    "origin_server_ts should be attached via into_update()"
                );
                table.apply_update(upd);
                received += 1;
            }
        }
    }

    assert!(
        received >= 1,
        "Bob should have received Alice's cell update through sync"
    );
    assert_eq!(
        table.get_value("t1", "title"),
        Some(&json!("Hello from Alice")),
        "Bob should converge on Alice's value via the real timeline"
    );
}

/// End-to-end ENCRYPTED round-trip (review §4.2): a cell update sent into an
/// E2E-encrypted room is Megolm-encrypted on the wire and must decrypt on the
/// other client. This proves the SDK's transparent encrypt-on-send /
/// decrypt-on-receive path works for our custom
/// `io.tidework.cell.update` events end to end — i.e. that enabling
/// encryption (review §4.2) does not break the read path.
#[tokio::test]
#[ignore]
async fn test_two_client_encrypted_round_trip() {
    let harness = TestHarness::new().await.unwrap();

    // Register two users and put them in a room that is encrypted from creation.
    let mut alice = harness.register_user("alice").await.unwrap();
    let mut bob = harness.register_user("bob").await.unwrap();
    let room_id = harness
        .create_encrypted_room(&alice, "secret-workspace")
        .await
        .unwrap();

    alice.sync_once().await.unwrap();
    alice.set_room_from_str(&room_id).unwrap();
    harness
        .invite_and_join(&alice, &bob, &room_id)
        .await
        .unwrap();
    bob.sync_once().await.unwrap();
    bob.set_room_from_str(&room_id).unwrap();

    // Alice must sync *after* Bob joins so she learns his device and shares the
    // Megolm room key with him when she sends.
    alice.sync_once().await.unwrap();

    // Sanity: both sides see the room as encrypted.
    let alice_room = alice.get_room().unwrap();
    let bob_room = bob.get_room().unwrap();
    assert!(
        alice_room.encryption_state().is_encrypted(),
        "room should be encrypted for alice"
    );
    assert!(
        bob_room.encryption_state().is_encrypted(),
        "room should be encrypted for bob"
    );

    // Alice sends a cell update — the SDK Megolm-encrypts it for Bob's device.
    let update = CellUpdate::new("tasks", "secret", "title", json!("Top secret"), 100);
    alice.send_cell_update(&update).await.unwrap();

    // Bob syncs to receive the to-device room key and the encrypted event, then
    // materializes from his (auto-decrypted) timeline.
    harness.wait_for_sync().await;
    bob.sync_once().await.unwrap();
    bob.sync_once().await.unwrap();

    let response = bob_room
        .messages(matrix_sdk::room::MessagesOptions::backward())
        .await
        .unwrap();

    let mut table = Table::new("tasks");
    let mut decrypted = 0;
    for event in &response.chunk {
        if let Ok(json_str) = serde_json::to_string(event.raw().json()) {
            if let Some(rx) = MatrixClient::extract_cell_update(&json_str) {
                table.apply_update(rx.into_update());
                decrypted += 1;
            }
        }
    }

    assert!(
        decrypted >= 1,
        "Bob should have decrypted at least one cell update from the encrypted room"
    );
    assert_eq!(
        table.get_value("secret", "title"),
        Some(&json!("Top secret")),
        "Bob should decrypt and converge on Alice's encrypted value"
    );
}
