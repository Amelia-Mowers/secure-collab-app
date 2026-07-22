//! Integration test for the account display-name round-trip (issue 1c8b3855)
//! backing the app's "Edit display name" account action and future CLI parity.
//!
//! ```sh
//! cargo test -p tables-over-matrix --no-default-features \
//!   --features matrix-native --test display_name_matrix -- --ignored
//! ```

#![cfg(feature = "matrix-native")]

mod harness;

use harness::TestHarness;

/// Setting a display name persists on the homeserver and reads back; setting
/// it again overwrites (the UI flow is exactly this: prefill, edit, save).
#[tokio::test]
#[ignore]
async fn display_name_set_and_read_back() {
    let harness = TestHarness::new().await.unwrap();
    let client = harness.register_user("dispname").await.unwrap();

    // A fresh account starts without a global display name (or the server may
    // default it to the localpart — accept either, just not our target value).
    let before = client.get_display_name().await.unwrap();
    assert_ne!(before.as_deref(), Some("Amelia in Prod"));

    client.set_display_name("Amelia in Prod").await.unwrap();
    assert_eq!(
        client.get_display_name().await.unwrap().as_deref(),
        Some("Amelia in Prod")
    );

    // Overwrite — the edit path.
    client.set_display_name("Amelia (work)").await.unwrap();
    assert_eq!(
        client.get_display_name().await.unwrap().as_deref(),
        Some("Amelia (work)")
    );
}
