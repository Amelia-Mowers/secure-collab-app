//! Matrix-aware WASM bridge.
//!
//! This module adds Matrix connectivity to the WASM bridge, providing:
//! - Login / logout
//! - Room (workspace) creation and joining
//! - Real-time sync with JS change notifications
//! - Invite / member listing
//!
//! The `MatrixSession` is the top-level WASM export that owns the Matrix
//! client. Individual `WasmWorkspace` instances are created *from* it
//! for each joined room.

use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

use matrix_sdk::{
    config::SyncSettings,
    ruma::{
        api::client::room::create_room::v3::Request as CreateRoomRequest,
        OwnedRoomId, OwnedUserId,
    },
    Client, LoopCtrl, RoomMemberships,
};

use crate::workspace::Workspace;
use tables_over_matrix::{CellUpdate, MatrixClient};

/// A Matrix session that owns the SDK client and can create workspaces
/// bound to rooms.
#[wasm_bindgen]
pub struct MatrixSession {
    client: Client,
    user_id: Option<OwnedUserId>,
}

#[wasm_bindgen]
impl MatrixSession {
    /// Connect to a homeserver and log in. Returns the user ID on success.
    #[wasm_bindgen]
    pub async fn login(
        homeserver_url: String,
        username: String,
        password: String,
    ) -> Result<MatrixSession, JsValue> {
        let client = Client::builder()
            .homeserver_url(&homeserver_url)
            .build()
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to connect: {e}")))?;

        client
            .matrix_auth()
            .login_username(&username, &password)
            .initial_device_display_name("Secure Collab")
            .await
            .map_err(|e| JsValue::from_str(&format!("Login failed: {e}")))?;

        let user_id = client.user_id().map(|u| u.to_owned());

        Ok(MatrixSession { client, user_id })
    }

    /// Get the logged-in user ID.
    #[wasm_bindgen(js_name = userId)]
    pub fn user_id(&self) -> Option<String> {
        self.user_id.as_ref().map(|u| u.to_string())
    }

    /// Create a new room (workspace) and return its room ID.
    #[wasm_bindgen(js_name = createRoom)]
    pub async fn create_room(&self, name: String) -> Result<String, JsValue> {
        let mut request = CreateRoomRequest::new();
        request.name = Some(name);
        request.preset = Some(
            matrix_sdk::ruma::api::client::room::create_room::v3::RoomPreset::PrivateChat,
        );

        let room = self
            .client
            .create_room(request)
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to create room: {e}")))?;

        Ok(room.room_id().to_string())
    }

    /// Join an existing room by ID.
    #[wasm_bindgen(js_name = joinRoom)]
    pub async fn join_room(&self, room_id: String) -> Result<(), JsValue> {
        let room_id: OwnedRoomId = room_id
            .as_str()
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid room ID"))?;

        self.client
            .join_room_by_id(&room_id)
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to join room: {e}")))?;

        Ok(())
    }

    /// List joined rooms. Returns a JSON array of `{id, name}` objects.
    #[wasm_bindgen(js_name = listRooms)]
    pub fn list_rooms(&self) -> String {
        let rooms: Vec<serde_json::Value> = self
            .client
            .joined_rooms()
            .iter()
            .map(|room| {
                serde_json::json!({
                    "id": room.room_id().to_string(),
                    "name": room.name().unwrap_or_default(),
                })
            })
            .collect();
        serde_json::to_string(&rooms).unwrap_or_else(|_| "[]".to_string())
    }

    /// Get a reference to the inner SDK client (for creating ConnectedWorkspace).
    pub(crate) fn inner(&self) -> &Client {
        &self.client
    }

    /// Perform an initial sync so the SDK knows about joined rooms.
    #[wasm_bindgen(js_name = initialSync)]
    pub async fn initial_sync(&self) -> Result<(), JsValue> {
        self.client
            .sync_once(SyncSettings::default())
            .await
            .map_err(|e| JsValue::from_str(&format!("Initial sync failed: {e}")))?;
        Ok(())
    }
}

// ── Connected Workspace ─────────────────────────────────────────────

/// A workspace backed by a Matrix room with real-time sync.
///
/// This wraps the local `Workspace` and adds:
/// - Sending cell updates to the room on every write
/// - A sync loop that receives updates from other clients
/// - A JS callback for change notifications
#[wasm_bindgen]
pub struct ConnectedWorkspace {
    /// Shared workspace state (Rc<RefCell> for WASM single-threaded access)
    inner: Rc<RefCell<Workspace>>,
    /// The Matrix SDK client
    client: Client,
    /// The room this workspace is bound to
    room_id: OwnedRoomId,
}

#[wasm_bindgen]
impl ConnectedWorkspace {
    /// Create a connected workspace from a session and room ID.
    #[wasm_bindgen(constructor)]
    pub fn new(session: &MatrixSession, room_id: String) -> Result<ConnectedWorkspace, JsValue> {
        let room_id: OwnedRoomId = room_id
            .as_str()
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid room ID"))?;

        // Verify the room exists in our session
        session
            .inner()
            .get_room(&room_id)
            .ok_or_else(|| JsValue::from_str("Room not found — did you run initialSync?"))?;

        let workspace = Workspace::new(room_id.to_string());

        Ok(ConnectedWorkspace {
            inner: Rc::new(RefCell::new(workspace)),
            client: session.inner().clone(),
            room_id,
        })
    }

    /// Start the sync loop. The provided `on_change` callback is invoked
    /// whenever the workspace state changes due to a remote update.
    ///
    /// This spawns an async task — it does NOT block.
    #[wasm_bindgen(js_name = startSync)]
    pub fn start_sync(&self, on_change: js_sys::Function) {
        let client = self.client.clone();
        let room_id = self.room_id.clone();
        let workspace = Rc::clone(&self.inner);

        spawn_local(async move {
            let settings = SyncSettings::default();

            let _ = client
                .sync_with_callback(settings, |response| {
                    let workspace = Rc::clone(&workspace);
                    let room_id = room_id.clone();
                    let on_change = on_change.clone();

                    async move {
                        // Look for our room in the sync response
                        if let Some(joined) = response.rooms.joined.get(&room_id) {
                            let mut changed = false;

                            for raw_event in &joined.timeline.events {
                                // Try to extract our custom event
                                if let Ok(json_str) = serde_json::to_string(raw_event.raw().json()) {
                                    if let Some(received) =
                                        MatrixClient::extract_cell_update(&json_str)
                                    {
                                        let mut ws = workspace.borrow_mut();
                                        let _ = ws.apply_update(received.update);
                                        changed = true;
                                    }
                                }
                            }

                            if changed {
                                let _ = on_change.call0(&JsValue::NULL);
                            }
                        }

                        LoopCtrl::Continue
                    }
                })
                .await;
        });
    }

    /// Invite a user to this workspace room.
    #[wasm_bindgen(js_name = inviteUser)]
    pub async fn invite_user(&self, user_id: String) -> Result<(), JsValue> {
        let user_id: OwnedUserId = user_id
            .as_str()
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid user ID"))?;

        let room = self
            .client
            .get_room(&self.room_id)
            .ok_or_else(|| JsValue::from_str("Room not found"))?;

        room.invite_user_by_id(&user_id)
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to invite user: {e}")))?;

        Ok(())
    }

    /// List room members. Returns a JSON array of user ID strings.
    #[wasm_bindgen(js_name = listMembers)]
    pub async fn list_members(&self) -> Result<String, JsValue> {
        let room = self
            .client
            .get_room(&self.room_id)
            .ok_or_else(|| JsValue::from_str("Room not found"))?;

        let members = room
            .members(RoomMemberships::ACTIVE)
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to list members: {e}")))?;

        let user_ids: Vec<serde_json::Value> = members
            .iter()
            .map(|m| {
                serde_json::json!({
                    "userId": m.user_id().to_string(),
                    "displayName": m.display_name().unwrap_or(""),
                })
            })
            .collect();

        serde_json::to_string(&user_ids)
            .map_err(|_| JsValue::from_str("Serialization failed"))
    }

    // ── Table operations (delegated to inner workspace + Matrix send) ──

    /// Create a table. Returns the cell updates as JSON.
    #[wasm_bindgen(js_name = createTable)]
    pub async fn create_table(&self, definition_json: &str) -> Result<String, JsValue> {
        let definition: crate::schema::TableDefinition =
            serde_json::from_str(definition_json)
                .map_err(|_| JsValue::from_str("Invalid table definition"))?;

        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.create_table(definition)
                .map_err(|_| JsValue::from_str("Failed to create table"))?
        };

        // Send updates to Matrix
        self.send_updates(&updates).await?;

        serde_json::to_string(&updates)
            .map_err(|_| JsValue::from_str("Serialization failed"))
    }

    /// Update a cell. Applies locally and sends to Matrix.
    #[wasm_bindgen(js_name = updateCell)]
    pub async fn update_cell(
        &self,
        table_id: String,
        row_id: String,
        column_id: String,
        value_json: &str,
    ) -> Result<(), JsValue> {
        let value: serde_json::Value =
            serde_json::from_str(value_json).map_err(|_| JsValue::from_str("Invalid JSON"))?;

        // Apply locally and capture the CellUpdate
        let update = {
            let mut ws = self.inner.borrow_mut();
            let ts = ws.next_timestamp_pub();
            let update = CellUpdate::new(&table_id, &row_id, &column_id, value, ts);
            ws.apply_update(update.clone())
                .map_err(|_| JsValue::from_str("Update failed"))?;
            update
        };

        // Send to Matrix
        self.send_updates(&[update]).await?;

        Ok(())
    }

    /// Delete a row from a table.
    #[wasm_bindgen(js_name = deleteRow)]
    pub fn delete_row(&self, table_id: String, row_id: String) -> Result<(), JsValue> {
        let mut ws = self.inner.borrow_mut();
        ws.delete_row(&table_id, &row_id)
            .map_err(|e| JsValue::from_str(&format!("{e}")))
    }

    /// Get all rows from a table as JSON.
    #[wasm_bindgen(js_name = getTableRows)]
    pub fn get_table_rows(&self, table_id: String) -> Result<String, JsValue> {
        let ws = self.inner.borrow();
        let rows = ws
            .get_table_rows(&table_id)
            .map_err(|_| JsValue::from_str("Table not found"))?;
        serde_json::to_string(&rows)
            .map_err(|_| JsValue::from_str("Serialization failed"))
    }

    /// Get table schema as JSON.
    #[wasm_bindgen(js_name = getTableSchema)]
    pub fn get_table_schema(&self, table_id: String) -> Result<String, JsValue> {
        let ws = self.inner.borrow();
        let schema = ws
            .get_table_schema(&table_id)
            .ok_or_else(|| JsValue::from_str("Table not found"))?;
        serde_json::to_string(&schema)
            .map_err(|_| JsValue::from_str("Serialization failed"))
    }

    /// List all tables.
    #[wasm_bindgen(js_name = listTables)]
    pub fn list_tables(&self) -> String {
        let ws = self.inner.borrow();
        let tables = ws.list_tables();
        serde_json::to_string(&tables).unwrap_or_else(|_| "[]".to_string())
    }

    /// Create a view from JSON configuration.
    #[wasm_bindgen(js_name = createView)]
    pub async fn create_view(&self, config_json: &str) -> Result<String, JsValue> {
        let config: crate::views::ViewConfig = serde_json::from_str(config_json)
            .map_err(|_| JsValue::from_str("Invalid view config"))?;

        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.create_view(config)
                .map_err(|_| JsValue::from_str("Failed to create view"))?
        };

        self.send_updates(&updates).await?;

        serde_json::to_string(&updates)
            .map_err(|_| JsValue::from_str("Serialization failed"))
    }

    /// Get view configuration as JSON.
    #[wasm_bindgen(js_name = getView)]
    pub fn get_view(&self, view_id: String) -> Result<String, JsValue> {
        let ws = self.inner.borrow();
        let view = ws
            .get_view(&view_id)
            .ok_or_else(|| JsValue::from_str("View not found"))?;
        serde_json::to_string(&view)
            .map_err(|_| JsValue::from_str("Serialization failed"))
    }

    /// List views for a table.
    #[wasm_bindgen(js_name = listViewsForTable)]
    pub fn list_views_for_table(&self, table_id: String) -> String {
        let ws = self.inner.borrow();
        let views = ws.list_views_for_table(&table_id);
        serde_json::to_string(&views).unwrap_or_else(|_| "[]".to_string())
    }

    /// Add a column to an existing table's schema.
    #[wasm_bindgen(js_name = addColumn)]
    pub async fn add_column(
        &self,
        table_id: String,
        column_json: &str,
    ) -> Result<(), JsValue> {
        let column: crate::schema::ColumnDefinition = serde_json::from_str(column_json)
            .map_err(|_| JsValue::from_str("Invalid column definition"))?;

        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.add_column(&table_id, column)
                .map_err(|_| JsValue::from_str("Failed to add column"))?
        };

        self.send_updates(&updates).await?;

        Ok(())
    }

    /// Apply a cell update from the network (manual).
    #[wasm_bindgen(js_name = applyUpdate)]
    pub fn apply_update(&self, update_json: &str) -> Result<(), JsValue> {
        let update: CellUpdate =
            serde_json::from_str(update_json).map_err(|_| JsValue::from_str("Invalid update"))?;
        let mut ws = self.inner.borrow_mut();
        ws.apply_update(update)
            .map_err(|_| JsValue::from_str("Failed to apply update"))
    }
}

// ── Private helpers (not exported to JS) ────────────────────────────

impl ConnectedWorkspace {
    /// Send a batch of CellUpdates to the Matrix room.
    async fn send_updates(&self, updates: &[CellUpdate]) -> Result<(), JsValue> {
        let room = self
            .client
            .get_room(&self.room_id)
            .ok_or_else(|| JsValue::from_str("Room not found"))?;

        for update in updates {
            let content: tables_over_matrix::CellUpdateEventContent = update.clone().into();
            room.send(content)
                .await
                .map_err(|e| JsValue::from_str(&format!("Failed to send update: {e}")))?;
        }

        Ok(())
    }
}
