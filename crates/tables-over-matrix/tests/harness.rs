//! Integration test harness for testing with a local Conduit homeserver.
//!
//! Starts a real Conduit instance on a random port, registers test users,
//! creates rooms, and tears everything down when the harness is dropped.

#![cfg(feature = "matrix")]
#![allow(dead_code)]

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::Duration;
use tables_over_matrix::MatrixClient;
use tokio::time::sleep;

/// Find a free TCP port by binding to port 0.
fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind to random port");
    listener.local_addr().unwrap().port()
}

/// A test harness that manages a local Synapse homeserver.
///
/// Synapse (not Conduit) so the integration tests run against the same
/// homeserver software as production (ADR 0002). Conduit omits the inviter's
/// membership from the invite stripped state, which breaks MSC4268
/// history-on-invite (`collaborator_history_matrix`); Synapse includes it.
///
/// On creation, generates a throwaway config + signing key, starts Synapse on a
/// random port with a temporary SQLite data directory, and waits until it
/// serves requests. On drop, kills the process and removes the data directory.
pub struct TestHarness {
    homeserver_process: Child,
    homeserver_url: String,
    data_dir: PathBuf,
    port: u16,
}

impl TestHarness {
    /// Start a real Synapse homeserver for testing.
    pub async fn new() -> Result<Self> {
        let port = free_port();
        let homeserver_url = format!("http://localhost:{port}");

        // Temporary data directory (native Linux fs under WSL — keep it off the
        // Windows mount for speed; std::env::temp_dir() is /tmp there).
        let data_dir = std::env::temp_dir().join(format!("synapse-test-{port}"));
        std::fs::create_dir_all(&data_dir).context("Failed to create temp data directory")?;

        // A Python logging config so Synapse writes its own logs to a file in the
        // data dir (handy when a start-up fails) instead of polluting stdout.
        let log_config_path = data_dir.join("log.config");
        std::fs::write(
            &log_config_path,
            format!(
                r#"version: 1
formatters:
  precise:
    format: '%(asctime)s %(levelname)s %(name)s - %(message)s'
handlers:
  file:
    class: logging.handlers.RotatingFileHandler
    formatter: precise
    filename: {log}
    maxBytes: 10485760
    backupCount: 1
    encoding: utf8
root:
  level: WARNING
  handlers: [file]
disable_existing_loggers: false
"#,
                log = data_dir.join("homeserver.log").display(),
            ),
        )
        .context("Failed to write Synapse log config")?;

        // Minimal Synapse config: SQLite, open registration without verification,
        // federation off, rate limits relaxed (tests register several users and
        // send many events fast), trusted_key_servers empty (no matrix.org).
        let config_path = data_dir.join("homeserver.yaml");
        std::fs::write(
            &config_path,
            format!(
                r#"server_name: "localhost"
pid_file: {pid}
public_baseurl: "{url}/"
listeners:
  - port: {port}
    type: http
    tls: false
    bind_addresses: ['127.0.0.1']
    x_forwarded: false
    resources:
      - names: [client]
        compress: false
database:
  name: sqlite3
  args:
    database: {db}
log_config: "{log_config}"
media_store_path: {media}
signing_key_path: "{signing_key}"
trusted_key_servers: []
suppress_key_server_warning: true
report_stats: false
enable_registration: true
enable_registration_without_verification: true
registration_requires_token: false
macaroon_secret_key: "test_macaroon_secret_key_do_not_use_in_prod"
form_secret: "test_form_secret_do_not_use_in_prod"
presence:
  enabled: false
rc_message:
  per_second: 1000
  burst_count: 1000
rc_registration:
  per_second: 1000
  burst_count: 1000
rc_login:
  address:
    per_second: 1000
    burst_count: 1000
  account:
    per_second: 1000
    burst_count: 1000
  failed_attempts:
    per_second: 1000
    burst_count: 1000
rc_joins:
  local:
    per_second: 1000
    burst_count: 1000
  remote:
    per_second: 1000
    burst_count: 1000
rc_invites:
  per_room:
    per_second: 1000
    burst_count: 1000
  per_user:
    per_second: 1000
    burst_count: 1000
"#,
                pid = data_dir.join("homeserver.pid").display(),
                url = homeserver_url,
                port = port,
                db = data_dir.join("homeserver.db").display(),
                log_config = log_config_path.display(),
                media = data_dir.join("media_store").display(),
                signing_key = data_dir.join("signing.key").display(),
            ),
        )
        .context("Failed to write Synapse config")?;

        // Generate the signing key referenced by the config (synchronous).
        let keygen = Command::new("synapse_homeserver")
            .arg("--config-path")
            .arg(&config_path)
            .arg("--generate-keys")
            .output()
            .context(
                "Failed to run synapse_homeserver --generate-keys — is matrix-synapse installed?",
            )?;
        if !keygen.status.success() {
            bail!(
                "Synapse key generation failed: {}",
                String::from_utf8_lossy(&keygen.stderr)
            );
        }

        // Start Synapse.
        let homeserver_process = Command::new("synapse_homeserver")
            .arg("--config-path")
            .arg(&config_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .context("Failed to start synapse_homeserver — is matrix-synapse installed?")?;

        let harness = Self {
            homeserver_process,
            homeserver_url,
            data_dir,
            port,
        };

        harness.wait_for_ready().await?;

        Ok(harness)
    }

    /// Poll Synapse until it responds to requests (or timeout).
    async fn wait_for_ready(&self) -> Result<()> {
        let client = reqwest::Client::new();
        let url = format!("{}/_matrix/client/versions", self.homeserver_url);

        // Synapse runs DB schema migrations on first start and is slower to come
        // up than Conduit, especially under parallel-test contention. 600 *
        // 100ms = 60s.
        for i in 0..600 {
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    eprintln!(
                        "[harness] Synapse ready on port {} (attempt {})",
                        self.port,
                        i + 1
                    );
                    return Ok(());
                }
                _ => sleep(Duration::from_millis(100)).await,
            }
        }

        bail!(
            "Synapse failed to start within 60 seconds on port {} (see {}/homeserver.log)",
            self.port,
            self.data_dir.display(),
        );
    }

    /// Get the homeserver URL for this test instance.
    pub fn homeserver_url(&self) -> &str {
        &self.homeserver_url
    }

    /// Register a user on the test homeserver and return an authenticated
    /// `MatrixClient`.
    pub async fn register_user(&self, username: &str) -> Result<MatrixClient> {
        let password = format!("{username}_test_password");

        let http = reqwest::Client::new();
        let register_url = format!("{}/_matrix/client/v3/register", self.homeserver_url);

        // Synapse gates /register behind user-interactive auth: the first call
        // (no `auth`) returns 401 with a `session` and the available flows; we
        // then resubmit with `m.login.dummy` carrying that session. (Conduit
        // accepted the dummy in one shot; Synapse does not.)
        let init = http
            .post(&register_url)
            .json(&serde_json::json!({ "username": username, "password": password }))
            .send()
            .await
            .context("Registration (init) request failed")?;

        // A fresh open-registration server replies 401 (UIA challenge). If it
        // somehow returns 200 immediately, we're already done.
        if !init.status().is_success() {
            let uia: serde_json::Value = init
                .json()
                .await
                .context("Registration UIA challenge was not JSON")?;
            let session = uia
                .get("session")
                .and_then(|s| s.as_str())
                .context("Registration UIA challenge had no session")?;

            let resp = http
                .post(&register_url)
                .json(&serde_json::json!({
                    "username": username,
                    "password": password,
                    "auth": { "type": "m.login.dummy", "session": session }
                }))
                .send()
                .await
                .context("Registration (complete) request failed")?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                bail!("Registration failed ({}): {}", status, text);
            }
        }

        // Create a MatrixClient and log in
        let client = MatrixClient::new(&self.homeserver_url).await?;
        client.login(username, &password).await?;

        Ok(client)
    }

    /// Log an *already-registered* user in on a FRESH `MatrixClient` — i.e. a
    /// new device with its own (empty) crypto store. Used to test multi-device
    /// key availability (review §4.2 / ADR 0001).
    pub async fn login_existing(&self, username: &str) -> Result<MatrixClient> {
        let password = format!("{username}_test_password");
        let client = MatrixClient::new(&self.homeserver_url).await?;
        client.login(username, &password).await?;
        Ok(client)
    }

    /// Create a room owned by the given client and return the room ID string.
    pub async fn create_room(&self, client: &MatrixClient, room_name: &str) -> Result<String> {
        let http = reqwest::Client::new();

        let token = client
            .inner()
            .access_token()
            .context("Client not logged in — no access token")?;

        let url = format!("{}/_matrix/client/r0/createRoom", self.homeserver_url);

        let body = serde_json::json!({
            "name": room_name,
            "preset": "private_chat",
            "visibility": "private",
        });

        let resp = http
            .post(&url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .context("Create room request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            bail!("Create room failed ({}): {}", status, text);
        }

        #[derive(Deserialize)]
        struct CreateRoomResponse {
            room_id: String,
        }
        let resp_body: CreateRoomResponse = resp.json().await?;
        Ok(resp_body.room_id)
    }

    /// Create an **E2E-encrypted** room (adds an `m.room.encryption` state event
    /// at creation, mirroring `ConnectedWorkspace::createRoom`) and return the
    /// room ID string.
    pub async fn create_encrypted_room(
        &self,
        client: &MatrixClient,
        room_name: &str,
    ) -> Result<String> {
        let http = reqwest::Client::new();

        let token = client
            .inner()
            .access_token()
            .context("Client not logged in — no access token")?;

        let url = format!("{}/_matrix/client/r0/createRoom", self.homeserver_url);

        let body = serde_json::json!({
            "name": room_name,
            "preset": "private_chat",
            "visibility": "private",
            "initial_state": [{
                "type": "m.room.encryption",
                "state_key": "",
                "content": { "algorithm": "m.megolm.v1.aes-sha2" }
            }],
        });

        let resp = http
            .post(&url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .context("Create encrypted room request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            bail!("Create encrypted room failed ({}): {}", status, text);
        }

        #[derive(Deserialize)]
        struct CreateRoomResponse {
            room_id: String,
        }
        let resp_body: CreateRoomResponse = resp.json().await?;
        Ok(resp_body.room_id)
    }

    /// Invite a user to a room and have them join it.
    pub async fn invite_and_join(
        &self,
        inviter: &MatrixClient,
        joiner: &MatrixClient,
        room_id: &str,
    ) -> Result<()> {
        let http = reqwest::Client::new();

        let inviter_token = inviter
            .inner()
            .access_token()
            .context("Inviter not logged in")?;

        let joiner_user_id = joiner
            .inner()
            .user_id()
            .context("Joiner not logged in")?
            .to_string();

        let joiner_token = joiner
            .inner()
            .access_token()
            .context("Joiner not logged in")?;

        // Invite
        let invite_url = format!(
            "{}/_matrix/client/r0/rooms/{}/invite",
            self.homeserver_url,
            urlencoded(room_id),
        );

        let resp = http
            .post(&invite_url)
            .bearer_auth(&inviter_token)
            .json(&serde_json::json!({ "user_id": joiner_user_id }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            bail!("Invite failed: {text}");
        }

        // Join
        let join_url = format!(
            "{}/_matrix/client/r0/join/{}",
            self.homeserver_url,
            urlencoded(room_id),
        );

        let resp = http
            .post(&join_url)
            .bearer_auth(&joiner_token)
            .json(&serde_json::json!({}))
            .send()
            .await?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            bail!("Join failed: {text}");
        }

        Ok(())
    }

    /// Invite a user to a room and have them join, **entirely through the
    /// matrix-rust-sdk** — the path production uses and the only one that makes
    /// MSC4268 "encrypted history on invite" work end to end.
    ///
    /// This is deliberately different from [`Self::invite_and_join`], which uses
    /// raw HTTP for both steps. Two SDK behaviours are load-bearing here and a
    /// raw-HTTP flow exercises neither:
    ///
    /// - **Invite (sender):** `Room::invite_user_by_id` (used by
    ///   `ConnectedWorkspace::inviteUser`) triggers `share_room_history`, which
    ///   bundles the room's shared-history Megolm keys, uploads them as an
    ///   encrypted file, and sends the recipient a to-device pointer — so the
    ///   invitee can later decrypt events sent *before* they joined. (Requires
    ///   the inviter to have cross-signing set up, else it silently no-ops.)
    /// - **Join (receiver):** `Client::join_room_by_id` records
    ///   `InviteAcceptanceDetails { invite_accepted_at, inviter }`. The bundle
    ///   receiver task *refuses* a historical-key bundle unless those details
    ///   are present (so a malicious homeserver can't inject history) — i.e. the
    ///   invitee must have joined via the SDK, from a synced invite, recently,
    ///   and the bundle's sender must match the recorded inviter.
    ///
    /// The inviter must already know the room (sync first), and the joiner must
    /// have synced at least once so their device keys / one-time keys are on the
    /// server for the inviter to establish an Olm session and deliver the bundle.
    pub async fn sdk_invite_and_join(
        &self,
        inviter: &MatrixClient,
        joiner: &MatrixClient,
        room_id: &str,
    ) -> Result<()> {
        use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId};

        let owned_room: OwnedRoomId = room_id
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid room id: {room_id}"))?;
        let joiner_user_id: OwnedUserId = joiner
            .inner()
            .user_id()
            .context("Joiner not logged in")?
            .to_owned();

        // SDK-level invite: matrix-rust-sdk bundles + uploads the shared-history
        // room keys and sends the to-device pointer to the invitee's devices.
        let room = inviter
            .inner()
            .get_room(&owned_room)
            .context("Inviter does not know the room — sync_once() before inviting")?;
        room.invite_user_by_id(&joiner_user_id)
            .await
            .context("SDK invite_user_by_id failed")?;

        // Joiner must SEE the invite (sync) so the SDK knows who invited them,
        // then accept THROUGH THE SDK so `InviteAcceptanceDetails` are recorded —
        // the gate the bundle receiver task checks before importing history.
        joiner
            .sync_once()
            .await
            .context("Joiner sync (to observe invite) failed")?;
        joiner
            .inner()
            .join_room_by_id(&owned_room)
            .await
            .context("SDK join_room_by_id failed")?;

        Ok(())
    }

    /// Wait for events to propagate between clients.
    pub async fn wait_for_sync(&self) {
        sleep(Duration::from_millis(500)).await;
    }
}

/// URL-encode a room ID (the `!` and `:` need escaping).
fn urlencoded(s: &str) -> String {
    s.replace('!', "%21")
        .replace(':', "%3A")
        .replace('#', "%23")
}

impl Drop for TestHarness {
    fn drop(&mut self) {
        let _ = self.homeserver_process.kill();
        let _ = self.homeserver_process.wait();
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

/// High-level helper: register N users, create a room, set it on all
/// clients, have everyone join.
///
/// Returns `(clients, room_id)` with each client's room already set.
pub async fn setup_workspace(
    harness: &TestHarness,
    usernames: &[&str],
) -> Result<(Vec<MatrixClient>, String)> {
    assert!(!usernames.is_empty(), "need at least one user");

    // Register all users
    let mut clients = Vec::with_capacity(usernames.len());
    for name in usernames {
        let client = harness.register_user(name).await?;
        clients.push(client);
    }

    // First user creates the room
    let room_id = harness.create_room(&clients[0], "test-workspace").await?;

    // First user syncs so the SDK knows about the room
    clients[0].sync_once().await?;
    clients[0].set_room_from_str(&room_id)?;

    // Invite and join remaining users
    for i in 1..clients.len() {
        harness
            .invite_and_join(&clients[0], &clients[i], &room_id)
            .await?;
        clients[i].sync_once().await?;
        clients[i].set_room_from_str(&room_id)?;
    }

    Ok((clients, room_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore] // Requires Conduit in PATH
    async fn test_harness_starts_conduit() {
        let harness = TestHarness::new().await.unwrap();
        assert!(harness.homeserver_url().starts_with("http://localhost:"));
    }

    #[tokio::test]
    #[ignore]
    async fn test_register_user() {
        let harness = TestHarness::new().await.unwrap();
        let _client = harness.register_user("testuser").await.unwrap();
    }
}
