//! Integration test harness for testing with a local Matrix homeserver.
//!
//! This module provides utilities for spinning up a test homeserver (Conduit)
//! and creating test clients for integration testing.
//!
//! Only available when the "matrix" feature is enabled.

#![cfg(feature = "matrix")]

use anyhow::Result;
use std::time::Duration;
use tokio::time::sleep;

/// A test harness that manages a local Conduit homeserver.
pub struct TestHarness {
    #[allow(dead_code)]
    conduit_process: Option<Child>,
    homeserver_url: String,
}

impl TestHarness {
    /// Create a new test harness.
    /// Note: This is a placeholder - a real implementation would:
    /// 1. Download/locate Conduit binary
    /// 2. Generate a test configuration
    /// 3. Start Conduit on a random port
    /// 4. Wait for it to be ready
    pub async fn new() -> Result<Self> {
        // For now, we'll use a mock homeserver URL
        // In a real implementation, this would start Conduit
        let homeserver_url = "http://localhost:8008".to_string();

        Ok(Self {
            conduit_process: None,
            homeserver_url,
        })
    }

    /// Get the homeserver URL for this test instance.
    pub fn homeserver_url(&self) -> &str {
        &self.homeserver_url
    }

    /// Create a test client and register a new user.
    pub async fn create_test_client(&self, username: &str) -> Result<tables_over_matrix::MatrixClient> {
        let client = tables_over_matrix::MatrixClient::new(&self.homeserver_url).await?;

        // In a real implementation:
        // 1. Register the user via the registration endpoint
        // 2. Login with the credentials
        // 3. Return the authenticated client

        // For now, this is a placeholder
        println!("Would create test client for user: {}", username);

        Ok(client)
    }

    /// Create a test room for workspace collaboration.
    pub async fn create_test_room(&self, _client: &tables_over_matrix::MatrixClient) -> Result<String> {
        // In a real implementation:
        // 1. Create a private encrypted room
        // 2. Enable E2E encryption
        // 3. Return the room ID

        // Placeholder
        Ok("!test-room:localhost".to_string())
    }

    /// Wait for sync to propagate between clients.
    pub async fn wait_for_sync(&self) {
        sleep(Duration::from_millis(100)).await;
    }
}

impl Drop for TestHarness {
    fn drop(&mut self) {
        // Clean up the Conduit process if it's running
        if let Some(mut process) = self.conduit_process.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
    }
}

/// Helper to create a test workspace room with multiple clients.
pub async fn create_collaborative_workspace(
    harness: &TestHarness,
    users: &[&str],
) -> Result<Vec<tables_over_matrix::MatrixClient>> {
    let mut clients = Vec::new();

    for username in users {
        let client = harness.create_test_client(username).await?;
        clients.push(client);
    }

    // Create a room with the first client
    if let Some(first_client) = clients.first() {
        let _room_id = harness.create_test_room(first_client).await?;

        // In a real implementation:
        // 1. Invite all other users to the room
        // 2. Have them join
        // 3. Wait for everyone to be synced
    }

    Ok(clients)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore] // Ignored by default as it requires a homeserver
    async fn test_harness_creation() {
        let harness = TestHarness::new().await.unwrap();
        assert!(!harness.homeserver_url().is_empty());
    }

    #[tokio::test]
    #[ignore]
    async fn test_create_test_client() {
        let harness = TestHarness::new().await.unwrap();
        let _client = harness.create_test_client("test_user").await.unwrap();
        // Client creation should succeed
    }
}
