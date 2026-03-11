//! Matrix SDK integration layer.
//!
//! This module is only available with the "matrix" feature enabled.
//! It's disabled for WASM builds since the Matrix SDK uses tokio networking.

#[cfg(feature = "matrix")]
pub use matrix_impl::*;

#[cfg(feature = "matrix")]
mod matrix_impl {
    use crate::cell::CellUpdate;
    use anyhow::{Context, Result};
    use matrix_sdk::{
        config::SyncSettings,
        room::Room,
        ruma::OwnedRoomId,
        Client,
    };
    use tracing::{debug, info};

    /// Event type for cell updates in Matrix rooms.
    pub const CELL_UPDATE_EVENT_TYPE: &str = "m.room.message";
    pub const CELL_UPDATE_MSGTYPE: &str = "com.securecollab.cell.update";

    /// A Matrix client wrapper for tables-over-matrix.
    pub struct MatrixClient {
        client: Client,
        /// The workspace room
        room_id: Option<OwnedRoomId>,
    }

    impl MatrixClient {
        /// Create a new Matrix client.
        pub async fn new(homeserver_url: &str) -> Result<Self> {
            let client = Client::builder()
                .homeserver_url(homeserver_url)
                .build()
                .await
                .context("Failed to create Matrix client")?;

            Ok(Self {
                client,
                room_id: None,
            })
        }

        /// Login with username and password.
        pub async fn login(&self, username: &str, password: &str) -> Result<()> {
            self.client
                .matrix_auth()
                .login_username(username, password)
                .initial_device_display_name("Secure Collab Client")
                .await
                .context("Failed to login")?;

            info!("Logged in as {}", username);
            Ok(())
        }

        /// Set the workspace room ID.
        pub fn set_room(&mut self, room_id: OwnedRoomId) {
            self.room_id = Some(room_id);
        }

        /// Get the workspace room.
        pub fn get_room(&self) -> Result<Room> {
            let room_id = self
                .room_id
                .as_ref()
                .context("No room ID set")?;

            self.client
                .get_room(room_id)
                .context("Room not found")
        }

        /// Send a cell update to the workspace room.
        pub async fn send_cell_update(&self, update: &CellUpdate) -> Result<()> {
            let _room = self.get_room()?;

            // TODO: Implement actual Matrix message sending
            // This is a placeholder for the Matrix SDK integration
            // In a real implementation, this would:
            // 1. Serialize the update as JSON
            // 2. Create a custom message event
            // 3. Send it to the room using the Matrix SDK

            debug!(
                "Would send cell update: {}.{}.{}",
                update.table_id, update.row_id, update.column_id
            );

            // Placeholder - actual implementation depends on Matrix SDK version
            anyhow::bail!("Matrix integration not yet implemented")
        }

        /// Send multiple cell updates (for user update + bump).
        pub async fn send_cell_updates(&self, updates: &[CellUpdate]) -> Result<()> {
            for update in updates {
                self.send_cell_update(update).await?;
            }
            Ok(())
        }

        /// Start syncing and return a stream of cell updates.
        /// This is a simplified version - in practice, you'd want a more sophisticated
        /// event stream with proper state management.
        pub async fn sync_once(&self) -> Result<()> {
            let settings = SyncSettings::default();

            self.client
                .sync_once(settings)
                .await
                .context("Sync failed")?;

            Ok(())
        }

        /// Extract cell updates from a sync response (simplified).
        /// In a real implementation, this would be called from a sync loop
        /// and properly handle the timeline events.
        pub fn extract_cell_update(_event_json: &str) -> Option<CellUpdate> {
            // TODO: Implement actual event extraction
            // This is a placeholder for the Matrix SDK integration
            // In a real implementation, this would:
            // 1. Parse the Matrix event
            // 2. Check if it's a cell update event
            // 3. Deserialize the CellUpdate from the event content

            None
        }

        /// Get the underlying Matrix SDK client.
        pub fn inner(&self) -> &Client {
            &self.client
        }
    }

    /// Session information for persistence.
    #[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
    pub struct SessionInfo {
        pub access_token: String,
        pub user_id: String,
        pub device_id: String,
        pub homeserver: String,
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;

        #[test]
        fn test_cell_update_serialization() {
            let update = CellUpdate::new("table1", "row1", "col1", json!("test"), 123);
            let serialized = serde_json::to_string(&update).unwrap();
            let deserialized: CellUpdate = serde_json::from_str(&serialized).unwrap();

            assert_eq!(update.table_id, deserialized.table_id);
            assert_eq!(update.row_id, deserialized.row_id);
            assert_eq!(update.column_id, deserialized.column_id);
            assert_eq!(update.timestamp, deserialized.timestamp);
        }
    }
}
