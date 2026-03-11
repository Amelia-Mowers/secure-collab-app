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
    use matrix_sdk::{
        config::SyncSettings,
        room::Room,
        ruma::{
            events::macros::EventContent, OwnedEventId, OwnedRoomId, MilliSecondsSinceUnixEpoch,
            UInt,
        },
        Client,
    };
    use serde::{Deserialize, Serialize};
    use tracing::{debug, info};

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
        let json_string = serde_json::to_string(value)
            .map_err(serde::ser::Error::custom)?;
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
        pub async fn send_cell_updates(
            &self,
            updates: &[CellUpdate],
        ) -> Result<Vec<OwnedEventId>> {
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
                .unwrap_or_else(|| {
                    MilliSecondsSinceUnixEpoch(UInt::from(0u32))
                });

            Some(ReceivedCellUpdate {
                update: cell_content.into(),
                event_id,
                origin_server_ts,
            })
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
                json!(3.14159265358979),
                100,
            );

            let json_str = serde_json::to_string(&content).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();

            // On the wire, the float is encoded as a string
            assert_eq!(parsed["value"], "3.14159265358979");

            // Round-trip: deserialize back to CellUpdateEventContent
            let decoded: CellUpdateEventContent = serde_json::from_str(&json_str).unwrap();
            assert_eq!(decoded.value, json!(3.14159265358979));
        }

        #[test]
        fn test_event_content_serialization_roundtrip_object() {
            let complex = json!({"tags": ["urgent"], "priority": 1});
            let content = CellUpdateEventContent::new(
                "tasks", "row_1", "metadata", complex.clone(), 200,
            );

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

            let received =
                MatrixClient::extract_cell_update(&event_json.to_string()).unwrap();

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
                    "value": "3.14",
                    "timestamp": 10
                },
                "sender": "@alice:example.com"
            });

            let received =
                MatrixClient::extract_cell_update(&event_json.to_string()).unwrap();
            assert_eq!(received.update.value, json!(3.14));
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
    }
}
