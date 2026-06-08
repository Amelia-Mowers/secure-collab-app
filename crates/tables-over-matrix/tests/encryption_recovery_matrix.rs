//! Integration tests for E2E key management — review §4.2 and
//! `docs/adr/0001-e2e-key-management.md`.
//!
//! This started as a *red* spec test (ADR 0001 test-first) and is now green:
//! it exercises the full multi-device recovery path — Secure Backup +
//! Recovery (Phase B) on top of auto cross-signing/backup (Phase A).
//!
//! ```sh
//! cargo test -p tables-over-matrix --no-default-features \
//!   --features matrix-native --test encryption_recovery_matrix -- --ignored
//! ```

#![cfg(feature = "matrix")]

mod harness;

use harness::TestHarness;
use serde_json::json;
use tables_over_matrix::{CellUpdate, MatrixClient, Table};

/// The single-user / multiple-devices promise: a SECOND login of the same user
/// (a fresh device with its own crypto store) decrypts the encrypted room
/// history and materializes the same workspace, after restoring keys from
/// Secure Backup with the recovery key.
///
/// Was red before Phases A–B: with no cross-signing + key backup, device 2 had
/// no Megolm keys for events sent before it existed, so `extract_cell_update`
/// skipped the (still-encrypted) events and the table came up empty. Now device
/// 1 enables backup + recovery and device 2 restores with the recovery key, so
/// the history decrypts (review §4.2 / ADR 0001).
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

    // Phase B: enable Secure Backup + Recovery and capture the recovery key.
    // This uploads device 1's room keys to the backup so another device can
    // restore them.
    let recovery_key = alice1.enable_recovery().await.unwrap();

    // Device 2: a fresh login of the SAME user (new, empty crypto store).
    let mut alice2 = harness.login_existing("alice").await.unwrap();
    alice2.sync_once().await.unwrap();

    // Phase B: restore secrets from backup with the saved recovery key, then
    // sync so the SDK downloads room keys and can decrypt history.
    alice2.recover_with_key(&recovery_key).await.unwrap();
    alice2.sync_once().await.unwrap();
    harness.wait_for_sync().await;
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

    // Device 2 decrypts the history it never had live keys for, via the backup
    // restored with the recovery key (review §4.2).
    assert_eq!(
        table.get_value("t1", "title"),
        Some(&json!("Top secret")),
        "second device should decrypt encrypted history after restoring from backup (§4.2)"
    );
}
