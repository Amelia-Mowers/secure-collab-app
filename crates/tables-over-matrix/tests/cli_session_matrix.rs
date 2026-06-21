//! Integration test for the native CLI's persistent SQLite store + session
//! save/restore round-trip (`with_sqlite_store` / `session_json` /
//! `restore_with_store`). These back the `tidework` CLI's cross-run login: a
//! user logs in once, and later runs restore the same device + crypto keys from
//! disk so they can decrypt existing workspaces without re-verifying.
//!
//! ```sh
//! cargo test -p tables-over-matrix --no-default-features \
//!   --features matrix-native --test cli_session_matrix -- --ignored
//! ```

#![cfg(feature = "matrix-native")]

mod harness;

use harness::TestHarness;
use tables_over_matrix::MatrixClient;

/// Logging in with a persistent SQLite store, saving the session blob, dropping
/// the client, then restoring against the SAME store reconstructs a working,
/// identically-identified session — same user, same device. This is the
/// foundation the CLI relies on to reuse a device across runs.
#[tokio::test]
#[ignore]
async fn cli_session_persists_and_restores() {
    let harness = TestHarness::new().await.unwrap();

    // Create the account on the homeserver (deterministic test password).
    let username = "clistore";
    harness.register_user(username).await.unwrap();
    let password = format!("{username}_test_password");

    // A fresh, isolated store dir for this run.
    let store_dir = std::env::temp_dir().join("tidework-cli-session-test");
    let _ = std::fs::remove_dir_all(&store_dir);
    std::fs::create_dir_all(&store_dir).unwrap();

    // 1) Log in with a persistent store; capture the session blob + identity.
    let blob: String;
    let user_id_before: String;
    let device_id_before: String;
    {
        let client = MatrixClient::with_sqlite_store(harness.homeserver_url(), &store_dir)
            .await
            .unwrap();
        client.login(username, &password).await.unwrap();

        user_id_before = client.user_id().expect("user id after login");
        device_id_before = client
            .inner()
            .device_id()
            .expect("device id after login")
            .to_string();
        blob = client.session_json().expect("session blob after login");

        // The blob is the bridge-compatible shape: a password session.
        let parsed: serde_json::Value = serde_json::from_str(&blob).unwrap();
        assert_eq!(parsed["kind"], "password");
        assert_eq!(parsed["userId"], user_id_before);
        assert!(
            parsed["accessToken"].as_str().is_some(),
            "blob must carry an access token"
        );

        // Drop the client here so the SQLite store lock is released before reopen.
    }

    // 2) Restore against the SAME store + blob: same user, same device, with no
    //    fresh login round trip.
    let restored = MatrixClient::restore_with_store(harness.homeserver_url(), &store_dir, &blob)
        .await
        .unwrap();

    assert_eq!(
        restored.user_id().as_deref(),
        Some(user_id_before.as_str()),
        "restored session must report the same user"
    );
    assert_eq!(
        restored.inner().device_id().map(|d| d.to_string()),
        Some(device_id_before),
        "restoring the same store must reuse the same device identity"
    );

    let _ = std::fs::remove_dir_all(&store_dir);
}
