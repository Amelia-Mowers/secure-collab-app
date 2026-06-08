//! Red (failing) integration tests for E2E key management — review §4.2 and
//! `docs/adr/0001-e2e-key-management.md`.
//!
//! These encode the DESIRED behaviour and currently FAIL because cross-signing
//! and key backup are not wired yet. They are the spec for §4.2: implement
//! until they go green.
//!
//! ```sh
//! cargo test -p tables-over-matrix --no-default-features \
//!   --features matrix-native,red-tests --test encryption_recovery_matrix -- --ignored
//! ```

// Gated behind `red-tests` so CI's `--ignored` integration run stays green;
// run with `--features matrix-native,red-tests`. See docs/adr/0001.
#![cfg(all(feature = "matrix", feature = "red-tests"))]

mod harness;

use harness::TestHarness;
use serde_json::json;
use tables_over_matrix::{CellUpdate, MatrixClient, Table};

/// The single-user / multiple-devices promise: a SECOND login of the same user
/// (a fresh device with its own crypto store) must decrypt the encrypted room
/// history and materialize the same workspace.
///
/// RED today: with no cross-signing + key backup, device 2 has no Megolm keys
/// for events sent before it existed, so `extract_cell_update` skips the
/// (still-encrypted) events and the table comes up empty. Goes green once
/// `EncryptionSettings` auto-backup + recovery are wired (Phases A–B), at which
/// point this test also gains a recovery-key restore step for device 2.
#[tokio::test]
#[ignore]
async fn test_second_device_reconstructs_encrypted_workspace_from_history() {
    let harness = TestHarness::new().await.unwrap();

    // Device 1: create an encrypted room and write a cell.
    let mut alice1 = harness.register_user("alice").await.unwrap();
    let room_id = harness
        .create_encrypted_room(&alice1, "workspace")
        .await
        .unwrap();
    alice1.sync_once().await.unwrap();
    alice1.set_room_from_str(&room_id).unwrap();

    let update = CellUpdate::new("tasks", "t1", "title", json!("Top secret"), 100);
    alice1.send_cell_update(&update).await.unwrap();
    harness.wait_for_sync().await;

    // Device 2: a fresh login of the SAME user (new, empty crypto store).
    let mut alice2 = harness.login_existing("alice").await.unwrap();
    alice2.sync_once().await.unwrap();
    alice2.sync_once().await.unwrap();
    alice2.set_room_from_str(&room_id).unwrap();

    // Device 2 materializes the workspace from the encrypted room history.
    let room = alice2.get_room().unwrap();
    let response = room
        .messages(matrix_sdk::room::MessagesOptions::backward())
        .await
        .unwrap();

    let mut table = Table::new("tasks");
    for event in &response.chunk {
        if let Ok(json_str) = serde_json::to_string(event.raw().json()) {
            if let Some(rx) = MatrixClient::extract_cell_update(&json_str) {
                table.apply_update(rx.into_update());
            }
        }
    }

    // DESIRED end state. Fails today because device 2 cannot decrypt history
    // without key backup (review §4.2).
    assert_eq!(
        table.get_value("t1", "title"),
        Some(&json!("Top secret")),
        "second device should decrypt encrypted history once key backup is wired (§4.2)"
    );
}
