//! Integration test harness for testing with a local Conduit homeserver.
//!
//! Starts a real Conduit instance on a random port, registers test users,
//! creates rooms, and tears everything down when the harness is dropped.

#![cfg(feature = "matrix")]
#![allow(dead_code)]

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::io::Write;
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

/// A test harness that manages a local Conduit homeserver.
///
/// On creation, starts Conduit on a random port with a temporary data
/// directory.  On drop, kills the process and removes the data directory.
pub struct TestHarness {
    conduit_process: Child,
    homeserver_url: String,
    data_dir: PathBuf,
    port: u16,
}

impl TestHarness {
    /// Start a real Conduit homeserver for testing.
    pub async fn new() -> Result<Self> {
        let port = free_port();
        let homeserver_url = format!("http://localhost:{port}");

        // Create a temporary data directory
        let data_dir = std::env::temp_dir().join(format!("conduit-test-{port}"));
        std::fs::create_dir_all(&data_dir).context("Failed to create temp data directory")?;

        // Write a minimal Conduit config
        let config_path = data_dir.join("conduit.toml");
        let config = format!(
            r#"[global]
server_name = "localhost"
database_backend = "rocksdb"
database_path = "{db_path}"
port = {port}
address = "127.0.0.1"
max_request_size = 20_000_000
allow_registration = true
allow_federation = false
trusted_servers = ["matrix.org"]
log = "warn"
"#,
            db_path = data_dir.join("db").display(),
            port = port,
        );
        let mut f =
            std::fs::File::create(&config_path).context("Failed to write conduit config")?;
        f.write_all(config.as_bytes())?;

        // Start Conduit
        let conduit_process = Command::new("conduit")
            .env("CONDUIT_CONFIG", config_path.to_str().unwrap())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .context("Failed to start Conduit — is matrix-conduit installed?")?;

        let harness = Self {
            conduit_process,
            homeserver_url,
            data_dir,
            port,
        };

        // Wait for Conduit to be ready
        harness.wait_for_ready().await?;

        Ok(harness)
    }

    /// Poll Conduit until it responds to requests (or timeout).
    async fn wait_for_ready(&self) -> Result<()> {
        let client = reqwest::Client::new();
        let url = format!("{}/_matrix/client/versions", self.homeserver_url);

        // Generous timeout: when several #[ignore]d tests run in parallel they
        // each spin up their own Conduit + RocksDB, and a cold start under that
        // contention can take well over 5s. 300 * 100ms = 30s.
        for i in 0..300 {
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    eprintln!(
                        "[harness] Conduit ready on port {} (attempt {})",
                        self.port,
                        i + 1
                    );
                    return Ok(());
                }
                _ => sleep(Duration::from_millis(100)).await,
            }
        }

        bail!(
            "Conduit failed to start within 30 seconds on port {}",
            self.port
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

        // POST to /register — Conduit with allow_registration=true
        // accepts m.login.dummy auth directly.
        let http = reqwest::Client::new();
        let register_url = format!("{}/_matrix/client/r0/register", self.homeserver_url);

        let body = serde_json::json!({
            "username": username,
            "password": password,
            "auth": {
                "type": "m.login.dummy"
            }
        });

        let resp = http
            .post(&register_url)
            .json(&body)
            .send()
            .await
            .context("Registration request failed")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            bail!("Registration failed ({}): {}", status, text);
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
        let _ = self.conduit_process.kill();
        let _ = self.conduit_process.wait();
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
