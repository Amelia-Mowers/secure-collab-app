//! Integration test: a workspace invite LINK, end to end, against a real
//! homeserver.
//!
//! Sharing a workspace requires the colleague's Matrix ID today, which means
//! they must already have an account (issue 5e362d42). A link cannot be an
//! ordinary invite — an invite names a user, and a link-holder has no user id
//! until they sign up. So: the room accepts knocks, the link carries a secret,
//! and an admin's client verifies the secret and admits the knocker.
//!
//! The rules that validate a token are unit-tested in `src/invite.rs` with no
//! Matrix in them. What only a homeserver can answer is whether the PROTOCOL
//! half works: does Synapse accept a knock on a room we opened, does the reason
//! survive to the admin, and does admitting actually produce a member who can
//! read the workspace. That is what this file is for.
//!
//! Run with: cargo test --features matrix-native -- --ignored

#![cfg(feature = "matrix-native")]

mod harness;

use harness::TestHarness;
use tables_over_matrix::invite;

const NOW: u64 = 1_700_000_000_000;
const HOUR: u64 = 3_600_000;

/// The whole point, in one test: a stranger with a link becomes a member.
#[tokio::test]
#[ignore]
async fn a_link_holder_knocks_and_is_admitted() {
    let harness = TestHarness::new().await.unwrap();

    let mut alice = harness.register_user("inv_alice").await.unwrap();
    let room_id = harness
        .create_room(&alice, "shared-workspace")
        .await
        .unwrap();
    alice.sync_once().await.unwrap();
    alice.set_room_from_str(&room_id).unwrap();

    // Alice mints a link. The secret comes back exactly once.
    let link = alice
        .create_invite_link(NOW, Some(HOUR), Some(5))
        .await
        .unwrap();
    assert!(!link.token.is_empty());

    // Sync before reading it back: state reaches the local store through sync,
    // and these harness clients sync only when told. A real client is already
    // syncing continuously, which is why this is a property of the test rather
    // than of `create_invite_link`.
    alice.sync_once().await.unwrap();

    // It is published, and what is published is a hash rather than the secret.
    let links = alice.list_invite_links().await.unwrap();
    let (state_key, content) = links
        .iter()
        .find(|(k, _)| *k == link.token_id)
        .expect("the minted link is not in room state");
    assert_eq!(state_key, &link.token_id);
    assert_ne!(content.token_hash, link.token);
    assert_eq!(content.uses, 0);

    // Bob has an account but no knowledge of the room beyond the link.
    let mut bob = harness.register_user("inv_bob").await.unwrap();
    bob.sync_once().await.unwrap();
    bob.knock_with_token(&room_id, &link.token).await.unwrap();

    // Alice sees the knock, and the token rides along on it — that is what
    // lets her client admit him without asking anyone anything.
    alice.sync_once().await.unwrap();
    let knocks = alice.list_knocks().await.unwrap();
    let (knocker, reason) = knocks
        .iter()
        .find(|(u, _)| u.contains("inv_bob"))
        .expect("alice cannot see bob's knock");
    assert_eq!(
        reason.as_deref(),
        Some(link.token.as_str()),
        "the knock reason did not carry the token"
    );

    alice.admit_knock(knocker, &link.token, NOW).await.unwrap();

    // Bob accepts and is a member.
    bob.sync_once().await.unwrap();
    let room_id_owned: matrix_sdk::ruma::OwnedRoomId = room_id.as_str().try_into().unwrap();
    bob.inner()
        .join_room_by_id(&room_id_owned)
        .await
        .expect("bob could not join after being admitted");
    bob.sync_once().await.unwrap();
    bob.set_room_from_str(&room_id).unwrap();

    // The use is counted, which is what makes a limited link limited.
    alice.sync_once().await.unwrap();
    let after = alice.list_invite_links().await.unwrap();
    let (_, content) = after
        .iter()
        .find(|(k, _)| *k == link.token_id)
        .expect("link vanished");
    assert_eq!(content.uses, 1, "admitting did not count a use");
}

/// A revoked link stops working, and the client refuses BEFORE inviting.
///
/// The order matters: if `admit_knock` invited first and checked after, a
/// revoked link would still let someone in and merely report an error.
#[tokio::test]
#[ignore]
async fn a_revoked_link_admits_nobody() {
    let harness = TestHarness::new().await.unwrap();

    let mut alice = harness.register_user("rev_alice").await.unwrap();
    let room_id = harness
        .create_room(&alice, "revoked-workspace")
        .await
        .unwrap();
    alice.sync_once().await.unwrap();
    alice.set_room_from_str(&room_id).unwrap();

    let link = alice.create_invite_link(NOW, None, None).await.unwrap();
    alice.sync_once().await.unwrap();

    let bob = harness.register_user("rev_bob").await.unwrap();
    bob.sync_once().await.unwrap();
    bob.knock_with_token(&room_id, &link.token).await.unwrap();

    alice.revoke_invite_link(&link.token_id).await.unwrap();
    alice.sync_once().await.unwrap();

    let knocks = alice.list_knocks().await.unwrap();
    let (knocker, _) = knocks
        .iter()
        .find(|(u, _)| u.contains("rev_bob"))
        .expect("no knock to admit");

    let err = alice
        .admit_knock(knocker, &link.token, NOW)
        .await
        .expect_err("a revoked link admitted someone");
    assert!(
        err.to_string().contains("revoked"),
        "unhelpful error: {err}"
    );

    // And he is still not a member: the check ran before the invite, not after.
    bob.sync_once().await.unwrap();
    let room_id_owned: matrix_sdk::ruma::OwnedRoomId = room_id.as_str().try_into().unwrap();
    assert!(
        bob.inner().join_room_by_id(&room_id_owned).await.is_err(),
        "bob joined a room he was never admitted to"
    );
}

/// A token that was never minted here admits nobody, and says so as
/// "not for this workspace" rather than leaking whether some other link exists.
#[tokio::test]
#[ignore]
async fn a_foreign_token_is_refused() {
    let harness = TestHarness::new().await.unwrap();

    let mut alice = harness.register_user("fgn_alice").await.unwrap();
    let room_id = harness
        .create_room(&alice, "foreign-workspace")
        .await
        .unwrap();
    alice.sync_once().await.unwrap();
    alice.set_room_from_str(&room_id).unwrap();
    let _real = alice.create_invite_link(NOW, None, None).await.unwrap();
    alice.sync_once().await.unwrap();

    // A well-formed token from somewhere else entirely.
    let other = invite::mint("@mallory:example.org", NOW, None, None).unwrap();

    let bob = harness.register_user("fgn_bob").await.unwrap();
    bob.sync_once().await.unwrap();
    bob.knock_with_token(&room_id, &other.token).await.unwrap();

    alice.sync_once().await.unwrap();
    let knocks = alice.list_knocks().await.unwrap();
    let (knocker, _) = knocks
        .iter()
        .find(|(u, _)| u.contains("fgn_bob"))
        .expect("no knock");

    let err = alice
        .admit_knock(knocker, &other.token, NOW)
        .await
        .expect_err("a foreign token admitted someone");
    assert!(
        err.to_string().contains("not valid for this workspace"),
        "unhelpful error: {err}"
    );
}

/// Knocking is opened only when a link is minted — a workspace with no link is
/// invite-only, and a stranger cannot knock their way in.
#[tokio::test]
#[ignore]
async fn a_workspace_with_no_link_cannot_be_knocked_on() {
    let harness = TestHarness::new().await.unwrap();

    let mut alice = harness.register_user("shut_alice").await.unwrap();
    let room_id = harness
        .create_room(&alice, "closed-workspace")
        .await
        .unwrap();
    alice.sync_once().await.unwrap();
    alice.set_room_from_str(&room_id).unwrap();

    let bob = harness.register_user("shut_bob").await.unwrap();
    bob.sync_once().await.unwrap();

    assert!(
        bob.knock_with_token(&room_id, "anything").await.is_err(),
        "an invite-only workspace accepted a knock"
    );
}
