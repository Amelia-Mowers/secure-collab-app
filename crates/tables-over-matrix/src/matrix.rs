//! Matrix SDK integration layer.
//!
//! This module is only available with the `matrix` feature enabled.
//! It provides:
//! - A custom Matrix event type (`CellUpdateEventContent`) for sending
//!   cell updates as proper typed events in a Matrix room.
//! - A `MatrixClient` wrapper that handles login, room management,
//!   sending/receiving cell updates, and sync.

#[cfg(feature = "matrix")]
pub use matrix_impl::*;

#[cfg(feature = "matrix")]
mod matrix_impl {
    use crate::cell::{CellUpdate, CELL_UPDATE_VERSION};
    use anyhow::Result;
    use matrix_sdk::encryption::{BackupDownloadStrategy, EncryptionSettings};
    use matrix_sdk::{
        config::SyncSettings,
        room::Room,
        ruma::{
            events::macros::EventContent, MilliSecondsSinceUnixEpoch, OwnedDeviceId, OwnedEventId,
            OwnedRoomId, UInt,
        },
        Client, RoomMemberships,
    };
    use serde::{Deserialize, Serialize};
    use tracing::{debug, info};

    /// Default client encryption settings (ADR 0001 / review §4.2): auto-enable
    /// cross-signing and key backup, and download backup keys on startup so a
    /// new device can decrypt and materialize encrypted workspace history.
    /// Apply at every `Client::builder()` call site.
    pub fn default_encryption_settings() -> EncryptionSettings {
        EncryptionSettings {
            auto_enable_cross_signing: true,
            auto_enable_backups: true,
            backup_download_strategy: BackupDownloadStrategy::OneShot,
        }
    }

    // ── Custom Matrix Event ─────────────────────────────────────────────

    /// The Matrix event type string for cell updates.
    ///
    /// Uses the reverse-DNS convention for custom event types as
    /// recommended by the Matrix spec. This is a timeline (message-like)
    /// event, not a state event, since each cell write is an append to
    /// the room timeline.
    pub const CELL_UPDATE_EVENT_TYPE: &str = "com.securecollab.cell.update";

    /// Matrix event content for a cell update.
    ///
    /// This struct is the canonical wire format for cell updates sent
    /// over Matrix. It uses ruma's `EventContent` derive macro to get
    /// proper (de)serialization and type registration with the SDK's
    /// event handler system.
    ///
    /// **Important:** The `value` field is serialized as a JSON *string*
    /// on the wire rather than an embedded JSON value. This is required
    /// because Matrix Canonical JSON prohibits float values (numbers with
    /// decimal points), so we encode the cell value as a string to allow
    /// any JSON type (including floats) to be transported safely.
    ///
    /// The JSON representation looks like:
    /// ```json
    /// {
    ///   "version": 1,
    ///   "table_id": "tasks",
    ///   "row_id": "row_abc",
    ///   "column_id": "title",
    ///   "value": "\"Buy groceries\"",
    ///   "timestamp": 1709312400
    /// }
    /// ```
    #[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
    #[ruma_event(type = "com.securecollab.cell.update", kind = MessageLike)]
    pub struct CellUpdateEventContent {
        /// Wire format version for forward compatibility.
        #[serde(default = "default_version")]
        pub version: u8,
        pub table_id: String,
        pub row_id: String,
        pub column_id: String,
        /// Cell value encoded as a JSON string to comply with Matrix
        /// Canonical JSON (which prohibits floats). The string contains
        /// the JSON-serialized form of the actual value.
        #[serde(
            serialize_with = "serialize_value_as_string",
            deserialize_with = "deserialize_value_from_string"
        )]
        pub value: serde_json::Value,
        /// Logical timestamp for LWW conflict resolution.
        pub timestamp: u64,
    }

    /// Serialize a `serde_json::Value` as a JSON string for the wire format.
    fn serialize_value_as_string<S>(
        value: &serde_json::Value,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let json_string = serde_json::to_string(value).map_err(serde::ser::Error::custom)?;
        serializer.serialize_str(&json_string)
    }

    /// Deserialize a `serde_json::Value` from a JSON-encoded string.
    ///
    /// On the wire, the `value` field is always a string containing
    /// JSON. This function parses that string back into a
    /// `serde_json::Value`.
    fn deserialize_value_from_string<'de, D>(
        deserializer: D,
    ) -> std::result::Result<serde_json::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let json_string = String::deserialize(deserializer)?;
        serde_json::from_str(&json_string).map_err(serde::de::Error::custom)
    }

    fn default_version() -> u8 {
        CELL_UPDATE_VERSION
    }

    impl CellUpdateEventContent {
        /// Create a new cell update event content.
        pub fn new(
            table_id: impl Into<String>,
            row_id: impl Into<String>,
            column_id: impl Into<String>,
            value: serde_json::Value,
            timestamp: u64,
        ) -> Self {
            Self {
                version: CELL_UPDATE_VERSION,
                table_id: table_id.into(),
                row_id: row_id.into(),
                column_id: column_id.into(),
                value,
                timestamp,
            }
        }
    }

    // ── Conversions between CellUpdate and CellUpdateEventContent ───────

    impl From<CellUpdate> for CellUpdateEventContent {
        fn from(update: CellUpdate) -> Self {
            Self {
                version: update.version,
                table_id: update.table_id,
                row_id: update.row_id,
                column_id: update.column_id,
                value: update.value,
                timestamp: update.timestamp,
            }
        }
    }

    impl From<CellUpdateEventContent> for CellUpdate {
        fn from(content: CellUpdateEventContent) -> Self {
            Self {
                version: content.version,
                table_id: content.table_id,
                row_id: content.row_id,
                column_id: content.column_id,
                value: content.value,
                timestamp: content.timestamp,
                // The wire format carries no server timestamp; it is attached
                // from the Matrix event envelope via `ReceivedCellUpdate::into_update`.
                server_timestamp: None,
            }
        }
    }

    /// A received cell update with Matrix metadata attached.
    #[derive(Debug, Clone)]
    pub struct ReceivedCellUpdate {
        /// The cell update data.
        pub update: CellUpdate,
        /// The Matrix event ID.
        pub event_id: OwnedEventId,
        /// Server-side timestamp (milliseconds since Unix epoch).
        /// Used as a tie-breaker for LWW resolution.
        pub origin_server_ts: MilliSecondsSinceUnixEpoch,
    }

    impl ReceivedCellUpdate {
        /// Consume into a [`CellUpdate`] with the Matrix `origin_server_ts`
        /// attached as the LWW tiebreaker for equal logical timestamps.
        pub fn into_update(self) -> CellUpdate {
            let server_ms: u64 = self.origin_server_ts.0.into();
            self.update.with_server_timestamp(server_ms)
        }
    }

    // ── Matrix Client ───────────────────────────────────────────────────

    /// A Matrix client wrapper for tables-over-matrix.
    ///
    /// Handles login, room management, and sending/receiving cell updates
    /// using the typed `CellUpdateEventContent` event.
    pub struct MatrixClient {
        client: Client,
        /// The workspace room.
        room_id: Option<OwnedRoomId>,
    }

    impl MatrixClient {
        /// Create a new Matrix client for the given homeserver.
        pub async fn new(homeserver_url: &str) -> Result<Self> {
            let client = Client::builder()
                .homeserver_url(homeserver_url)
                .with_encryption_settings(default_encryption_settings())
                .build()
                .await
                .map_err(|e| anyhow::anyhow!("Failed to create Matrix client: {e}"))?;

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
                .map_err(|e| anyhow::anyhow!("Failed to login: {e}"))?;

            info!("Logged in as {}", username);
            Ok(())
        }

        /// Set the workspace room ID.
        pub fn set_room(&mut self, room_id: OwnedRoomId) {
            self.room_id = Some(room_id);
        }

        /// Set the workspace room ID from a string (e.g. "!abc:localhost").
        pub fn set_room_from_str(&mut self, room_id: &str) -> anyhow::Result<()> {
            let owned: OwnedRoomId = room_id
                .try_into()
                .map_err(|_| anyhow::anyhow!("Invalid room ID: {room_id}"))?;
            self.room_id = Some(owned);
            Ok(())
        }

        /// Get the workspace room.
        pub fn get_room(&self) -> Result<Room> {
            let room_id = self
                .room_id
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("No room ID set"))?;
            self.client
                .get_room(room_id)
                .ok_or_else(|| anyhow::anyhow!("Room not found"))
        }

        /// Send a cell update to the workspace room.
        ///
        /// Converts the `CellUpdate` into a typed `CellUpdateEventContent`
        /// and sends it as a timeline event. Returns the event ID on success.
        pub async fn send_cell_update(&self, update: &CellUpdate) -> Result<OwnedEventId> {
            let room = self.get_room()?;
            let content: CellUpdateEventContent = update.clone().into();

            debug!(
                "Sending cell update: {}.{}.{} (ts={})",
                update.table_id, update.row_id, update.column_id, update.timestamp
            );

            let response = room
                .send(content)
                .await
                .map_err(|e| anyhow::anyhow!("Failed to send cell update: {e}"))?;

            debug!("Cell update sent, event_id={}", response.event_id);
            Ok(response.event_id)
        }

        /// Send multiple cell updates in sequence (e.g., user write + bump).
        pub async fn send_cell_updates(&self, updates: &[CellUpdate]) -> Result<Vec<OwnedEventId>> {
            let mut event_ids = Vec::with_capacity(updates.len());
            for update in updates {
                let event_id = self.send_cell_update(update).await?;
                event_ids.push(event_id);
            }
            Ok(event_ids)
        }

        /// Parse a raw Matrix event JSON into a `CellUpdate`, if it is
        /// a `com.securecollab.cell.update` event.
        ///
        /// Returns `None` if the event is a different type or fails to parse.
        pub fn extract_cell_update(event_json: &str) -> Option<ReceivedCellUpdate> {
            // Parse the outer event envelope
            let raw: serde_json::Value = serde_json::from_str(event_json).ok()?;

            let event_type = raw.get("type")?.as_str()?;
            if event_type != CELL_UPDATE_EVENT_TYPE {
                return None;
            }

            let content = raw.get("content")?;
            let cell_content: CellUpdateEventContent =
                serde_json::from_value(content.clone()).ok()?;

            let event_id_str = raw.get("event_id")?.as_str()?;
            let event_id: OwnedEventId = event_id_str.try_into().ok()?;

            // Convert u64 milliseconds to MilliSecondsSinceUnixEpoch via UInt
            let origin_server_ts = raw
                .get("origin_server_ts")
                .and_then(|v| v.as_u64())
                .and_then(|ms| UInt::try_from(ms).ok())
                .map(MilliSecondsSinceUnixEpoch)
                .unwrap_or_else(|| MilliSecondsSinceUnixEpoch(UInt::from(0u32)));

            Some(ReceivedCellUpdate {
                update: cell_content.into(),
                event_id,
                origin_server_ts,
            })
        }

        /// Whether `event_json` is still an `m.room.encrypted` event — i.e. the
        /// SDK could not decrypt it (no room key available). Cold start / sync
        /// use this to *count and surface* undecryptable history rather than
        /// silently skipping it (which would materialize wrong workspace state).
        /// See `docs/adr/0001-e2e-key-management.md` / review §4.2.
        pub fn is_undecryptable_event(event_json: &str) -> bool {
            serde_json::from_str::<serde_json::Value>(event_json)
                .ok()
                .and_then(|v| {
                    v.get("type")
                        .and_then(|t| t.as_str())
                        .map(|s| s == "m.room.encrypted")
                })
                .unwrap_or(false)
        }

        /// Run a single sync cycle and return.
        pub async fn sync_once(&self) -> Result<()> {
            let settings = SyncSettings::default();
            self.client
                .sync_once(settings)
                .await
                .map_err(|e| anyhow::anyhow!("Sync failed: {e}"))?;
            Ok(())
        }

        /// Get the underlying Matrix SDK client.
        pub fn inner(&self) -> &Client {
            &self.client
        }

        // ── Secure Backup / Recovery (ADR 0001 Phase B) ─────────────────────

        /// Enable Secure Backup + Recovery and return the **recovery key** the
        /// user must save. Bootstraps secret storage and key backup and waits
        /// for this device's room keys to finish uploading, so another device
        /// can later restore encrypted workspace history with the returned key.
        ///
        /// Called once on the device that creates a workspace. The recovery key
        /// is the user's only way back into their history on a fresh device —
        /// it must be surfaced and saved (review §4.2 / ADR 0001).
        pub async fn enable_recovery(&self) -> Result<String> {
            let recovery_key = self
                .client
                .encryption()
                .recovery()
                .enable()
                .wait_for_backups_to_upload()
                .await
                .map_err(|e| anyhow::anyhow!("Failed to enable recovery: {e}"))?;
            info!("Secure backup + recovery enabled");
            Ok(recovery_key)
        }

        /// Restore secrets (including the backup decryption key) from Secure
        /// Backup using a previously-saved recovery key. Afterwards the SDK
        /// downloads room keys from backup so this device can decrypt history
        /// that was sent before it existed — the multi-device promise.
        pub async fn recover_with_key(&self, recovery_key: &str) -> Result<()> {
            self.client
                .encryption()
                .recovery()
                .recover(recovery_key)
                .await
                .map_err(|e| anyhow::anyhow!("Failed to recover from backup: {e}"))?;
            info!("Recovered secrets from secure backup");
            Ok(())
        }

        /// Count devices of the workspace room's members that this device has
        /// not verified (excluding our own current device). The SDK shares room
        /// keys with *every* device in an encrypted room, verified or not, so
        /// surfacing this lets the user see that data is going to devices whose
        /// identity hasn't been attested. See ADR 0001 Phase D / review §4.2.
        pub async fn unverified_device_count(&self) -> Result<usize> {
            let room = self.get_room()?;
            count_unverified_devices(&self.client, &room).await
        }

        /// Whether the given device of *our own* user is verified from this
        /// device's perspective (via SAS or cross-signing). Used to confirm a
        /// verification flow took effect and to drive trust UI. ADR 0001 Phase D.
        pub async fn is_device_verified(&self, device_id: &str) -> Result<bool> {
            let user_id = self
                .client
                .user_id()
                .ok_or_else(|| anyhow::anyhow!("Not logged in"))?;
            let device_id: OwnedDeviceId = device_id.into();
            let device = self
                .client
                .encryption()
                .get_device(user_id, &device_id)
                .await
                .map_err(|e| anyhow::anyhow!("Failed to get device: {e}"))?
                .ok_or_else(|| anyhow::anyhow!("Device not found"))?;
            Ok(device.is_verified())
        }
    }

    /// Count the **anomalous** unverified devices among this room's members:
    /// devices that are *not* verified but belong to **another user whose
    /// identity we have verified**. That combination is the catastrophic case —
    /// a collaborator we've attested suddenly has a device we haven't, which
    /// looks like a device injection. Two kinds of device are deliberately *not*
    /// counted so the warning only fires when something is genuinely wrong
    /// (ADR 0001 Phase D):
    ///
    /// - devices of users we've never verified (a routine unverified peer is
    ///   normal, not catastrophic), and
    /// - our own devices — a fresh/unverified device of ours is handled up front
    ///   by the sign-in verify gate and the incoming-verification prompt, not by
    ///   a passive workspace banner.
    pub async fn count_unverified_devices(client: &Client, room: &Room) -> Result<usize> {
        let own_user_id = client.user_id();
        let mut count = 0usize;

        let members = room
            .members(RoomMemberships::JOIN)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to list room members: {e}"))?;

        for member in members {
            let user_id = member.user_id();

            // Own devices are the verify gate's job, not this banner's.
            if Some(user_id) == own_user_id {
                continue;
            }

            // Only a *verified* collaborator's unverified device is an anomaly.
            let identity_verified = client
                .encryption()
                .get_user_identity(user_id)
                .await
                .map_err(|e| anyhow::anyhow!("Failed to fetch user identity: {e}"))?
                .map(|identity| identity.is_verified())
                .unwrap_or(false);
            if !identity_verified {
                continue;
            }

            let devices = client
                .encryption()
                .get_user_devices(user_id)
                .await
                .map_err(|e| anyhow::anyhow!("Failed to fetch user devices: {e}"))?;
            for device in devices.devices() {
                if !device.is_verified() {
                    count += 1;
                }
            }
        }

        Ok(count)
    }

    /// Session information for persistence.
    #[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
    pub struct SessionInfo {
        pub access_token: String,
        pub user_id: String,
        pub device_id: String,
        pub homeserver: String,
    }

    // ── Tests ───────────────────────────────────────────────────────────

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;

        #[test]
        fn test_cell_update_to_event_content_roundtrip() {
            let update = CellUpdate::new("table1", "row1", "col1", json!("hello"), 42);
            let content: CellUpdateEventContent = update.clone().into();
            let back: CellUpdate = content.into();

            assert_eq!(back.version, update.version);
            assert_eq!(back.table_id, update.table_id);
            assert_eq!(back.row_id, update.row_id);
            assert_eq!(back.column_id, update.column_id);
            assert_eq!(back.value, update.value);
            assert_eq!(back.timestamp, update.timestamp);
        }

        #[test]
        fn test_event_content_serialization() {
            let content = CellUpdateEventContent::new(
                "tasks",
                "task_1",
                "title",
                json!("Buy groceries"),
                1709312400,
            );

            let json_str = serde_json::to_string(&content).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

            assert_eq!(parsed["version"], 1);
            assert_eq!(parsed["table_id"], "tasks");
            assert_eq!(parsed["row_id"], "task_1");
            assert_eq!(parsed["column_id"], "title");
            // Value is now a JSON-encoded string on the wire
            assert_eq!(parsed["value"], "\"Buy groceries\"");
            assert_eq!(parsed["timestamp"], 1709312400u64);
        }

        #[test]
        fn test_event_content_serialization_roundtrip_float() {
            let content = CellUpdateEventContent::new(
                "metrics",
                "row_1",
                "temperature",
                json!(9.87654321),
                100,
            );

            let json_str = serde_json::to_string(&content).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

            // On the wire, the float is encoded as a string
            assert_eq!(parsed["value"], "9.87654321");

            // Round-trip: deserialize back to CellUpdateEventContent
            let decoded: CellUpdateEventContent = serde_json::from_str(&json_str).unwrap();
            assert_eq!(decoded.value, json!(9.87654321));
        }

        #[test]
        fn test_event_content_serialization_roundtrip_object() {
            let complex = json!({"tags": ["urgent"], "priority": 1});
            let content =
                CellUpdateEventContent::new("tasks", "row_1", "metadata", complex.clone(), 200);

            let json_str = serde_json::to_string(&content).unwrap();
            let decoded: CellUpdateEventContent = serde_json::from_str(&json_str).unwrap();
            assert_eq!(decoded.value, complex);
        }

        #[test]
        fn test_event_content_deserialize_without_version() {
            // Events without a version field should default to 1.
            // The value field is a JSON-encoded string.
            let json_str = r#"{
                "table_id": "t1",
                "row_id": "r1",
                "column_id": "c1",
                "value": "\"test\"",
                "timestamp": 100
            }"#;

            let content: CellUpdateEventContent = serde_json::from_str(json_str).unwrap();
            assert_eq!(content.version, CELL_UPDATE_VERSION);
            assert_eq!(content.value, json!("test"));
        }

        #[test]
        fn test_extract_cell_update_from_event_json() {
            // The wire format has value encoded as a JSON string
            let event_json = json!({
                "type": "com.securecollab.cell.update",
                "event_id": "$abc123:example.com",
                "origin_server_ts": 1709312400000u64,
                "content": {
                    "version": 1,
                    "table_id": "tasks",
                    "row_id": "task_1",
                    "column_id": "title",
                    "value": "\"Buy groceries\"",
                    "timestamp": 42
                },
                "sender": "@alice:example.com"
            });

            let received = MatrixClient::extract_cell_update(&event_json.to_string()).unwrap();

            assert_eq!(received.update.table_id, "tasks");
            assert_eq!(received.update.row_id, "task_1");
            assert_eq!(received.update.column_id, "title");
            assert_eq!(received.update.value, json!("Buy groceries"));
            assert_eq!(received.update.timestamp, 42);
            assert_eq!(received.event_id.as_str(), "$abc123:example.com");
        }

        #[test]
        fn test_extract_cell_update_with_float_value() {
            let event_json = json!({
                "type": "com.securecollab.cell.update",
                "event_id": "$float123:example.com",
                "origin_server_ts": 100,
                "content": {
                    "version": 1,
                    "table_id": "metrics",
                    "row_id": "r1",
                    "column_id": "temperature",
                    "value": "2.72",
                    "timestamp": 10
                },
                "sender": "@alice:example.com"
            });

            let received = MatrixClient::extract_cell_update(&event_json.to_string()).unwrap();
            assert_eq!(received.update.value, json!(2.72));
        }

        #[test]
        fn test_extract_ignores_non_cell_events() {
            let event_json = json!({
                "type": "m.room.message",
                "event_id": "$xyz:example.com",
                "origin_server_ts": 0,
                "content": {
                    "msgtype": "m.text",
                    "body": "hello"
                },
                "sender": "@bob:example.com"
            });

            assert!(MatrixClient::extract_cell_update(&event_json.to_string()).is_none());
        }

        #[test]
        fn test_is_undecryptable_event() {
            // An m.room.encrypted event = the SDK couldn't decrypt it.
            let encrypted = json!({
                "type": "m.room.encrypted",
                "event_id": "$enc:example.com",
                "origin_server_ts": 0,
                "content": { "algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "…" },
                "sender": "@alice:example.com"
            })
            .to_string();
            assert!(MatrixClient::is_undecryptable_event(&encrypted));

            // A decrypted cell update is not undecryptable.
            let cell = json!({ "type": CELL_UPDATE_EVENT_TYPE, "content": {} }).to_string();
            assert!(!MatrixClient::is_undecryptable_event(&cell));

            // Other event types are not "undecryptable" — just not ours.
            let other = json!({ "type": "m.room.message", "content": {} }).to_string();
            assert!(!MatrixClient::is_undecryptable_event(&other));
        }
    }
}
