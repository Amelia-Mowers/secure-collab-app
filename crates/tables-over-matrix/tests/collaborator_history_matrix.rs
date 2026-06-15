//! Integration test: a NEW COLLABORATOR reconstructs workspace history that
//! was written *before they joined* — review §4.2 / `docs/adr/0001-e2e-key-
//! management.md`.
//!
//! This is the case neither `encryption_recovery_matrix` nor `two_client_sync`
//! covers, and it is the one that matters for the product's collaboration
//! promise:
//!
//! - `test_second_device_reconstructs_encrypted_workspace_from_history` is the
//!   *same user, new device* path — recovered from **Secure Backup** with the
//!   user's own recovery key.
//! - `test_two_client_encrypted_round_trip` writes *after* the second user has
//!   already joined, so the SDK simply shares the *current* Megolm session with
//!   them — it never tests reading history from before they joined.
//!
//! A real collaborator does NOT have the workspace owner's recovery key, so the
//! backup path is unavailable to them. The only way they can decrypt pre-join
//! history is if the inviter's device **forwards the shared-history Megolm room
//! keys** when it invites them (MSC4268, "encrypted history on invite"). The SDK
//! does this from `Room::invite_user_by_id` when the client is built with
//! `with_enable_share_history_on_invite(true)` (see `MatrixClient::new`) and the
//! room has `shared` history visibility (the `private_chat` preset).
//!
//! Because our workspace state is **materialized by replaying the encrypted
//! timeline**, a collaborator missing pre-join keys does not see a "🔒 can't
//! decrypt" marker — they silently materialize *incomplete/wrong* table state
//! (ADR 0001, "Undecryptable history = wrong data, silently"). So this is a
//! correctness property, asserted two ways below: (1) zero undecryptable events
//! in the replayed history, and (2) every pre-join cell materializes.
//!
//! ## Why the harness runs Synapse, not Conduit
//!
//! This test was the reason the integration harness moved from Conduit to
//! Synapse. The MSC4268 *transport* works on either: the inviter builds the key
//! bundle (`shared_keys=1`), uploads it as an encrypted file, and the invitee
//! receives and decrypts the `io.element.msc4268.room_key_bundle` to-device
//! event. But the SDK's *receiver gating* needs to resolve the **inviter** from
//! the invite's stripped state — `Client::join_room_by_id` →
//! `prepare_join_room_by_id` → `Room::invite_details` → `get_member_no_sync` —
//! to import the bundle and record the authorising `InviteAcceptanceDetails`.
//! **Conduit omits the inviter's own `m.room.member` from the invite
//! `invite_room_state`** (it sends create/name/join_rules/encryption + the
//! invitee's own member event only), so on Conduit `invite_details()` returns
//! `inviter: None` and the bundle is never imported. **Synapse includes the
//! inviter's membership**, so the import happens synchronously on join and this
//! test passes. Production runs Synapse + MAS (ADR 0002), so this matches prod.
//!
//! ```sh
//! cargo test -p tables-over-matrix --no-default-features \
//!   --features matrix-native --test collaborator_history_matrix -- --ignored
//! ```

#![cfg(feature = "matrix")]

mod harness;

use harness::TestHarness;
use serde_json::json;
use tables_over_matrix::{CellUpdate, MatrixClient, Table};

/// A collaborator invited *after* a workspace already has data must decrypt and
/// materialize the **full** pre-join history, not just events sent after they
/// joined.
///
/// The invite + join both go through the SDK (`sdk_invite_and_join`): the SDK
/// invite is what builds and sends the historical-key bundle, and the SDK join
/// is what records the invite-acceptance details that authorise importing it.
/// See the module docs for why this requires the Synapse harness (not Conduit).
#[tokio::test]
#[ignore]
async fn test_new_collaborator_reconstructs_pre_join_history() {
    let harness = TestHarness::new().await.unwrap();

    // Alice creates an encrypted workspace and writes data BEFORE Bob exists.
    let mut alice = harness.register_user("alice").await.unwrap();
    let room_id = harness
        .create_encrypted_room(&alice, "workspace")
        .await
        .unwrap();
    alice.sync_once().await.unwrap();
    alice.set_room_from_str(&room_id).unwrap();

    // MSC4268's sender side (`share_room_history`) silently no-ops unless the
    // inviter has cross-signing set up. Enabling recovery bootstraps secret
    // storage + cross-signing, guaranteeing Alice has an own-identity so the
    // historical-key bundle is actually built and sent.
    alice.enable_recovery().await.unwrap();

    // Pre-join history: several cells across two rows, written while Alice is the
    // only member. These are encrypted under a Megolm session Bob has never seen.
    let pre_join = vec![
        CellUpdate::new("tasks", "t1", "title", json!("Ship v1"), 100),
        CellUpdate::new("tasks", "t1", "status", json!("in_progress"), 101),
        CellUpdate::new("tasks", "t2", "title", json!("Write tests"), 102),
    ];
    alice.send_cell_updates(&pre_join).await.unwrap();
    harness.wait_for_sync().await;

    // Bob registers and syncs so his device keys + one-time keys are uploaded —
    // the inviter needs them to establish an Olm session and deliver the bundle.
    let mut bob = harness.register_user("bob").await.unwrap();
    bob.sync_once().await.unwrap();

    // Alice invites Bob THROUGH THE SDK (mirrors ConnectedWorkspace::inviteUser),
    // which sends the historical-key bundle; Bob syncs to see the invite and then
    // accepts via the SDK (which, on a conforming homeserver, records the
    // invite-acceptance details that gate bundle import). See `sdk_invite_and_join`.
    harness
        .sdk_invite_and_join(&alice, &bob, &room_id)
        .await
        .unwrap();

    // On a homeserver that exposes the inviter in the invite stripped state
    // (Synapse), the bundle is imported *synchronously* during the SDK join
    // (`finish_join_room` → `maybe_accept_key_bundle`), so Bob already has the
    // keys here. One settle sync is enough.
    bob.sync_once().await.unwrap();
    bob.set_room_from_str(&room_id).unwrap();

    // Bob materializes the workspace from history he never had *live* keys for.
    let room = bob.get_room().unwrap();
    let response = room
        .messages(matrix_sdk::room::MessagesOptions::backward())
        .await
        .unwrap();

    let mut table = Table::new("tasks");
    let mut undecryptable = 0u32;
    for event in &response.chunk {
        if let Ok(json_str) = serde_json::to_string(event.raw().json()) {
            if let Some(rx) = MatrixClient::extract_cell_update(&json_str) {
                table.apply_update(rx.into_update());
            } else if MatrixClient::is_undecryptable_event(&json_str) {
                // Pre-join event Bob has no key for — exactly the silent-wrong-
                // data failure this test exists to catch.
                undecryptable += 1;
            }
        }
    }

    // (1) No part of the pre-join history may be left undecryptable — otherwise
    // Bob would render a silently-incomplete workspace (ADR 0001 §4.2).
    assert_eq!(
        undecryptable, 0,
        "new collaborator should have keys for ALL pre-join history, but {undecryptable} \
         event(s) were undecryptable — the inviter's historical-key bundle was not imported \
         (the inviter must be resolvable from the invite stripped state; see module docs)"
    );

    // (2) Every pre-join cell must materialize with its written value.
    assert_eq!(
        table.get_value("t1", "title"),
        Some(&json!("Ship v1")),
        "collaborator should decrypt pre-join cell t1.title"
    );
    assert_eq!(
        table.get_value("t1", "status"),
        Some(&json!("in_progress")),
        "collaborator should decrypt pre-join cell t1.status"
    );
    assert_eq!(
        table.get_value("t2", "title"),
        Some(&json!("Write tests")),
        "collaborator should decrypt pre-join cell t2.title"
    );
}
