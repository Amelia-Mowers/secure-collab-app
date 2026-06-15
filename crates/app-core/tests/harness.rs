//! Integration test harness for app-core tests with a local Synapse homeserver.
//!
//! Mirrors the tables-over-matrix harness (Synapse so tests run against the same
//! homeserver software as prod — ADR 0002) but creates `Workspace` instances
//! with Matrix connectivity.

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

use app_core::Workspace;

/// Find a free TCP port by binding to port 0.
fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind to random port");
    listener.local_addr().unwrap().port()
}

/// A test harness that manages a local Synapse homeserver.
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

        let data_dir = std::env::temp_dir().join(format!("synapse-appcore-test-{port}"));
        std::fs::create_dir_all(&data_dir).context("Failed to create temp data directory")?;

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

    pub fn homeserver_url(&self) -> &str {
        &self.homeserver_url
    }

    /// Register a user on the test homeserver and return an authenticated `MatrixClient`.
    pub async fn register_user(&self, username: &str) -> Result<MatrixClient> {
        let password = format!("{username}_test_password");

        let http = reqwest::Client::new();
        let register_url = format!("{}/_matrix/client/v3/register", self.homeserver_url);

        // Synapse gates /register behind user-interactive auth: the first call
        // (no `auth`) returns 401 with a `session`; resubmit with `m.login.dummy`
        // carrying that session. (Conduit accepted the dummy in one shot.)
        let init = http
            .post(&register_url)
            .json(&serde_json::json!({ "username": username, "password": password }))
            .send()
            .await
            .context("Registration (init) request failed")?;

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

/// High-level helper: register N users, create a room, set it on all clients.
/// Returns `(clients, room_id)` with each client's room already set.
pub async fn setup_workspace(
    harness: &TestHarness,
    usernames: &[&str],
) -> Result<(Vec<MatrixClient>, String)> {
    assert!(!usernames.is_empty(), "need at least one user");

    let mut clients = Vec::with_capacity(usernames.len());
    for name in usernames {
        let client = harness.register_user(name).await?;
        clients.push(client);
    }

    let room_id = harness.create_room(&clients[0], "test-workspace").await?;

    clients[0].sync_once().await?;
    clients[0].set_room_from_str(&room_id)?;

    for i in 1..clients.len() {
        harness
            .invite_and_join(&clients[0], &clients[i], &room_id)
            .await?;
        clients[i].sync_once().await?;
        clients[i].set_room_from_str(&room_id)?;
    }

    Ok((clients, room_id))
}

/// Create a Workspace with an attached MatrixClient.
pub fn connected_workspace(room_id: &str, client: MatrixClient) -> Workspace {
    let mut ws = Workspace::new(room_id);
    ws.set_matrix_client(client);
    ws
}
