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
use matrix_sdk::encryption::verification::Verification;
use serde_json::json;
use std::time::Duration;
use tables_over_matrix::{CellUpdate, MatrixClient};

/// A routine unverified collaborator must NOT be surfaced — that's a normal
/// state, not a catastrophe. The banner only fires for a *verified* identity's
/// unverified device (a possible injection). Here Alice has never verified Bob,
/// so even though she has downloaded his (unverified) device, the count is 0
/// (ADR 0001 Phase D — warnings only for genuine problems).
#[tokio::test]
#[ignore]
async fn test_routine_unverified_collaborator_is_not_surfaced() {
    let harness = TestHarness::new().await.unwrap();

    // Alice creates an encrypted room; Bob (never verified) joins.
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
    alice.sync_once().await.unwrap();

    // Sending an encrypted update forces Alice to download Bob's device keys —
    // so the device IS known, it's just (correctly) not flagged.
    let update = CellUpdate::new("tasks", "t1", "title", json!("hello"), 1);
    alice.send_cell_update(&update).await.unwrap();
    alice.sync_once().await.unwrap();
    harness.wait_for_sync().await;

    let count = alice.unverified_device_count().await.unwrap();
    assert_eq!(
        count, 0,
        "a never-verified collaborator's device must not be surfaced, got {count}"
    );
}

/// Sync both clients once and pause so to-device verification events propagate.
///
/// Uses a short sync timeout: the default long-poll would block ~30s whenever
/// the next verification event hasn't arrived yet, making the handshake take
/// many minutes. A bounded timeout returns as soon as events are available (or
/// after a short wait), keeping each polling iteration fast.
async fn sync_both(a: &MatrixClient, b: &MatrixClient) {
    let settings = matrix_sdk::config::SyncSettings::default().timeout(Duration::from_millis(500));
    let _ = a.inner().sync_once(settings.clone()).await;
    let _ = b.inner().sync_once(settings).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
}

/// Two devices of the same user complete an SAS (emoji) verification and end up
/// mutually verified. This is the mechanism that lets a user attest that the
/// devices receiving room keys are genuinely theirs (review §4.2 / ADR 0001
/// Phase D). The flow is interactive (to-device messages each way), so we pump
/// both clients' syncs between steps and poll the live request/SAS handles.
#[tokio::test]
#[ignore]
async fn test_two_devices_self_verify_via_sas() {
    let harness = TestHarness::new().await.unwrap();

    // Device 1 registers; device 2 is a fresh second login of the same user.
    let alice1 = harness.register_user("alice").await.unwrap();
    let alice2 = harness.login_existing("alice").await.unwrap();

    let user_id = alice1.inner().user_id().unwrap().to_owned();
    let dev1 = alice1.inner().device_id().unwrap().to_owned();
    let dev2 = alice2.inner().device_id().unwrap().to_owned();

    // Both sync until each knows about the other device.
    for _ in 0..12 {
        sync_both(&alice1, &alice2).await;
        let known = alice1
            .inner()
            .encryption()
            .get_device(&user_id, &dev2)
            .await
            .unwrap()
            .is_some()
            && alice2
                .inner()
                .encryption()
                .get_device(&user_id, &dev1)
                .await
                .unwrap()
                .is_some();
        if known {
            break;
        }
    }

    // alice1 requests verification of alice2's device.
    let device2_from_1 = alice1
        .inner()
        .encryption()
        .get_device(&user_id, &dev2)
        .await
        .unwrap()
        .expect("alice1 should know alice2's device");
    let req1 = device2_from_1.request_verification().await.unwrap();
    let flow_id = req1.flow_id().to_owned();

    // alice2 receives the request and accepts it.
    let mut req2 = None;
    for _ in 0..24 {
        sync_both(&alice1, &alice2).await;
        if let Some(r) = alice2
            .inner()
            .encryption()
            .get_verification_request(&user_id, &flow_id)
            .await
        {
            req2 = Some(r);
            break;
        }
    }
    let req2 = req2.expect("alice2 should receive the verification request");
    req2.accept().await.unwrap();

    // alice1 waits until the request is ready, then starts SAS.
    for _ in 0..24 {
        sync_both(&alice1, &alice2).await;
        if req1.is_ready() {
            break;
        }
    }
    assert!(req1.is_ready(), "verification request should become ready");
    let sas1 = req1
        .start_sas()
        .await
        .unwrap()
        .expect("start_sas should yield a SAS verification");

    // alice2 picks up the started SAS and accepts it.
    let mut sas2 = None;
    for _ in 0..24 {
        sync_both(&alice1, &alice2).await;
        if let Some(Verification::SasV1(s)) = alice2
            .inner()
            .encryption()
            .get_verification(&user_id, &flow_id)
            .await
        {
            sas2 = Some(s);
            break;
        }
    }
    let sas2 = sas2.expect("alice2 should receive the SAS verification");
    sas2.accept().await.unwrap();

    // Pump until both sides have exchanged keys (the emoji become available).
    for _ in 0..24 {
        sync_both(&alice1, &alice2).await;
        if sas1.emoji().is_some() && sas2.emoji().is_some() {
            break;
        }
    }
    assert!(
        sas1.emoji().is_some() && sas2.emoji().is_some(),
        "both sides should reach key exchange (emoji available)"
    );

    // In a real UI the user confirms the emoji match; the SAS is derived from
    // the same shared secret, so here we trust it and confirm on both sides.
    sas1.confirm().await.unwrap();
    sas2.confirm().await.unwrap();

    // Pump until the flow completes on both sides.
    for _ in 0..24 {
        sync_both(&alice1, &alice2).await;
        if sas1.is_done() && sas2.is_done() {
            break;
        }
    }
    assert!(
        sas1.is_done() && sas2.is_done(),
        "SAS should complete on both sides"
    );

    // Let the resulting device-trust signatures propagate.
    for _ in 0..8 {
        sync_both(&alice1, &alice2).await;
    }

    // Each device now sees the other as verified.
    assert!(
        alice1.is_device_verified(dev2.as_str()).await.unwrap(),
        "alice1 should see alice2's device as verified after SAS"
    );
    assert!(
        alice2.is_device_verified(dev1.as_str()).await.unwrap(),
        "alice2 should see alice1's device as verified after SAS"
    );
}
