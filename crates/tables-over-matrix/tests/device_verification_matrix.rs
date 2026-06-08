//! Integration test for device-trust surfacing — review §4.2 and
//! `docs/adr/0001-e2e-key-management.md` Phase D (warn-on-unverified).
//!
//! The SDK shares room keys with *every* device in an encrypted room, verified
//! or not, so a malicious/compromised homeserver could inject a device and
//! receive the keys. Before any verification UX exists, the app must at least
//! *surface* that unverified devices are present, so the user knows their data
//! is going somewhere unattested.
//!
//! ```sh
//! cargo test -p tables-over-matrix --no-default-features \
//!   --features matrix-native --test device_verification_matrix -- --ignored
//! ```

#![cfg(feature = "matrix")]

mod harness;

use harness::TestHarness;
use serde_json::json;
use tables_over_matrix::CellUpdate;

/// With a collaborator (a second user) in the encrypted room, that user's
/// device is unverified from our perspective and must be counted, so the UI can
/// warn that data is being shared with an unattested device (review §4.2).
#[tokio::test]
#[ignore]
async fn test_unverified_member_device_is_surfaced() {
    let harness = TestHarness::new().await.unwrap();

    // Alice creates an encrypted room; Bob (a second user) joins it.
    let mut alice = harness.register_user("alice").await.unwrap();
    let bob = harness.register_user("bob").await.unwrap();
    let room_id = harness
        .create_encrypted_room(&alice, "workspace")
        .await
        .unwrap();
    alice.sync_once().await.unwrap();
    alice.set_room_from_str(&room_id).unwrap();

    harness
        .invite_and_join(&alice, &bob, &room_id)
        .await
        .unwrap();
    // Alice syncs so she sees Bob's membership before sending.
    alice.sync_once().await.unwrap();

    // Sending an encrypted update forces Alice to download Bob's device keys
    // (she must encrypt the Megolm session for each of Bob's devices).
    let update = CellUpdate::new("tasks", "t1", "title", json!("hello"), 1);
    alice.send_cell_update(&update).await.unwrap();
    alice.sync_once().await.unwrap();
    harness.wait_for_sync().await;

    // Bob's device is unverified from Alice's perspective → surfaced.
    let count = alice.unverified_device_count().await.unwrap();
    assert!(
        count >= 1,
        "alice should see at least bob's unverified device, got {count}"
    );
}
