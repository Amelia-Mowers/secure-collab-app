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

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

use matrix_sdk::{
    authentication::oauth::{
        registration::ClientMetadata, ClientId, ClientRegistrationData,
        OAuthSession as SdkOAuthSession, UserSession,
    },
    config::SyncSettings,
    encryption::verification::{SasVerification, Verification},
    room::MessagesOptions,
    ruma::{
        api::client::room::create_room::v3::Request as CreateRoomRequest,
        events::{macros::EventContent, StateEventType},
        serde::Raw,
        OwnedDeviceId, OwnedRoomId, OwnedUserId,
    },
    AuthSession, Client, LoopCtrl, RoomMemberships, SessionChange, SessionMeta, SessionTokens,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Custom state event type string to tag rooms as workspaces.
const WORKSPACE_STATE_TYPE: &str = "io.tidework.workspace";

/// Content for the workspace marker state event.
#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "io.tidework.workspace", kind = State, state_key_type = String)]
pub struct WorkspaceMarkerEventContent {
    /// Always true — the presence of this event marks the room as a workspace.
    pub workspace: bool,
}

use crate::workspace::Workspace;
use tables_over_matrix::{default_encryption_settings, CellUpdate, MatrixClient};

/// Sanitize a string for use as part of an IndexedDB database name.
fn sanitize_store_key(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
}

/// A fresh, unique IndexedDB store name for a new login.
///
/// One store per device identity: every login/registration creates a new
/// Matrix device, and its Olm state must live in its own store from the very
/// first key upload (device keys are immutable once uploaded, so the store
/// must be configured *before* login, which is why the name can't include the
/// device ID). The name is persisted in the session blob (`sessionData`) so
/// `restore()` reopens the same store.
fn new_store_name(username: &str) -> String {
    format!(
        "tw-{}-{}",
        sanitize_store_key(username),
        js_sys::Date::now() as u64
    )
}

/// Serialize the client's current auth session into the persisted blob shape
/// (`kind`/`userId`/`deviceId`/`accessToken`/`refreshToken`/`clientId`/
/// `storeName`). Reads live tokens from `client.session()`, so calling it after
/// a token refresh yields the *current* tokens — that's what lets
/// `startTokenPersistence` re-save fresh tokens. Returns `None` if there is no
/// active session or its auth type is unsupported.
fn serialize_session(client: &Client, store_name: &Option<String>) -> Option<String> {
    // `storeName`: the IndexedDB store backing this device's state + crypto
    // stores; restore() must reopen the same one to keep the device identity.
    let data = match client.session()? {
        AuthSession::Matrix(ms) => serde_json::json!({
            "kind": "password",
            "userId": ms.meta.user_id.to_string(),
            "deviceId": ms.meta.device_id.to_string(),
            "accessToken": ms.tokens.access_token,
            "storeName": store_name,
        }),
        AuthSession::OAuth(os) => serde_json::json!({
            "kind": "oauth",
            "userId": os.user.meta.user_id.to_string(),
            "deviceId": os.user.meta.device_id.to_string(),
            "accessToken": os.user.tokens.access_token,
            "refreshToken": os.user.tokens.refresh_token,
            // The dynamically-registered OAuth client id — needed to restore
            // the registered client alongside the session.
            "clientId": os.client_id.as_str(),
            "storeName": store_name,
        }),
        _ => return None,
    };
    serde_json::to_string(&data).ok()
}

/// A Matrix session that owns the SDK client and can create workspaces
/// bound to rooms.
#[wasm_bindgen]
pub struct MatrixSession {
    client: Client,
    user_id: Option<OwnedUserId>,
    /// IndexedDB store name backing this session's state + crypto stores.
    store_name: Option<String>,
}

#[wasm_bindgen]
impl MatrixSession {
    /// Connect to a homeserver and log in. Returns the user ID on success.
    ///
    /// State and crypto stores are persisted in IndexedDB so the device's Olm
    /// account, Megolm sessions, and verification state survive page reloads —
    /// without this, every reload would be an unverified "new device" that
    /// can't decrypt its own history.
    #[wasm_bindgen]
    pub async fn login(
        homeserver_url: String,
        username: String,
        password: String,
    ) -> Result<MatrixSession, JsValue> {
        let store_name = new_store_name(&username);
        let client = Client::builder()
            .homeserver_url(&homeserver_url)
            .indexeddb_store(&store_name, None)
            .with_encryption_settings(default_encryption_settings())
            // Share encrypted room history with invitees (MSC4268) so new
            // collaborators can decrypt workspace data written before they
            // joined; mirrors MatrixClient::new. Requires a homeserver that
            // exposes the inviter in the invite stripped state — prod's Synapse
            // does (see the collaborator_history_matrix integration test).
            .with_enable_share_history_on_invite(true)
            // OAuth (MAS) access tokens are short-lived; without this the SDK
            // never spends the refresh token and every request after expiry
            // 401s with M_UNKNOWN_TOKEN — booting the user and tripping the
            // verify gate on the next reload. Refreshed tokens are persisted
            // by `startTokenPersistence`.
            .handle_refresh_tokens()
            .build()
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to connect: {e}")))?;

        client
            .matrix_auth()
            .login_username(&username, &password)
            .initial_device_display_name("TideWork")
            .await
            .map_err(|e| JsValue::from_str(&format!("Login failed: {e}")))?;

        let user_id = client.user_id().map(|u| u.to_owned());

        Ok(MatrixSession {
            client,
            user_id,
            store_name: Some(store_name),
        })
    }

    /// Register a new account on the homeserver and log in.
    ///
    /// Uses the Matrix Client-Server `register` endpoint. If the server
    /// requires a dummy UIAA stage (common for Conduit and Synapse with
    /// open registration) it is handled automatically.
    #[wasm_bindgen]
    pub async fn register(
        homeserver_url: String,
        username: String,
        password: String,
    ) -> Result<MatrixSession, JsValue> {
        use matrix_sdk::ruma::api::client::{account::register, uiaa};

        let store_name = new_store_name(&username);
        let client = Client::builder()
            .homeserver_url(&homeserver_url)
            .indexeddb_store(&store_name, None)
            .with_encryption_settings(default_encryption_settings())
            // Share encrypted room history with invitees (MSC4268) so new
            // collaborators can decrypt workspace data written before they
            // joined; mirrors MatrixClient::new. Requires a homeserver that
            // exposes the inviter in the invite stripped state — prod's Synapse
            // does (see the collaborator_history_matrix integration test).
            .with_enable_share_history_on_invite(true)
            // OAuth (MAS) access tokens are short-lived; without this the SDK
            // never spends the refresh token and every request after expiry
            // 401s with M_UNKNOWN_TOKEN — booting the user and tripping the
            // verify gate on the next reload. Refreshed tokens are persisted
            // by `startTokenPersistence`.
            .handle_refresh_tokens()
            .build()
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to connect: {e}")))?;

        // Build initial registration request (no auth data — probes UIAA)
        let mut request = register::v3::Request::new();
        request.username = Some(username.clone());
        request.password = Some(password.clone());
        request.initial_device_display_name = Some("TideWork".to_owned());

        let result = client.matrix_auth().register(request).await;

        match result {
            Ok(_response) => {
                // Registration succeeded without UIAA (rare but possible)
            }
            Err(err) => {
                // Check if the error is a UIAA response requiring a dummy stage
                if let Some(info) = err.as_uiaa_response() {
                    let mut dummy = uiaa::Dummy::new();
                    dummy.session = info.session.clone();
                    let mut retry = register::v3::Request::new();
                    retry.username = Some(username.clone());
                    retry.password = Some(password.clone());
                    retry.initial_device_display_name = Some("TideWork".to_owned());
                    retry.auth = Some(uiaa::AuthData::Dummy(dummy));

                    client
                        .matrix_auth()
                        .register(retry)
                        .await
                        .map_err(|e| JsValue::from_str(&format!("Registration failed: {e}")))?;
                } else {
                    return Err(JsValue::from_str(&format!("Registration failed: {err}")));
                }
            }
        }

        let user_id = client.user_id().map(|u| u.to_owned());

        Ok(MatrixSession {
            client,
            user_id,
            store_name: Some(store_name),
        })
    }

    /// Get the logged-in user ID.
    #[wasm_bindgen(js_name = userId)]
    pub fn user_id(&self) -> Option<String> {
        self.user_id.as_ref().map(|u| u.to_string())
    }

    // ── Secure Backup / Recovery (ADR 0001 Phase B) ─────────────────────────
    //
    // A sign-in that can't reach history is a useless state, so the sign-in
    // flow must leave every device able to read history — either by
    // *bootstrapping* recovery (first device: history protected going forward)
    // or by *restoring* from backup (returning device). These are the
    // primitives the UI drives after `initialSync()` to guarantee that.

    /// Classify this device's access to encrypted history:
    /// - `"ready"`: recovery is set up and this device already has the keys.
    /// - `"needs_bootstrap"`: no backup exists yet — the first device should
    ///   call `enableRecovery()` to protect history and get a key to save.
    /// - `"needs_recovery"`: a backup exists but this device lacks the keys —
    ///   call `recoverWithKey()` with the saved recovery key to read history.
    /// - `"unknown"`: not determined yet; sync first.
    ///
    /// Call after `initialSync()` so the SDK has learned the backup state.
    #[wasm_bindgen(js_name = recoveryStatus)]
    pub fn recovery_status(&self) -> String {
        use matrix_sdk::encryption::recovery::RecoveryState;
        match self.client.encryption().recovery().state() {
            RecoveryState::Enabled => "ready",
            RecoveryState::Incomplete => "needs_recovery",
            RecoveryState::Disabled => "needs_bootstrap",
            _ => "unknown",
        }
        .to_owned()
    }

    /// Bootstrap Secure Backup + Recovery for the FIRST device and return the
    /// **recovery key** the user must save. After this, other devices can
    /// restore history with the key. The returned key must be surfaced
    /// prominently — it is the only way back into history on a fresh device.
    #[wasm_bindgen(js_name = enableRecovery)]
    pub async fn enable_recovery(&self) -> Result<String, JsValue> {
        // Delegates to the shared implementation so the auto-backup race
        // handling (see tables_over_matrix::enable_recovery) isn't duplicated.
        tables_over_matrix::enable_recovery(&self.client)
            .await
            .map_err(|e| JsValue::from_str(&format!("{e}")))
    }

    /// Restore secrets from Secure Backup using a saved recovery key so this
    /// (returning) device can decrypt history sent before it existed.
    #[wasm_bindgen(js_name = recoverWithKey)]
    pub async fn recover_with_key(&self, recovery_key: String) -> Result<(), JsValue> {
        self.client
            .encryption()
            .recovery()
            .recover(&recovery_key)
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to recover from backup: {e}")))?;
        Ok(())
    }

    /// Create a new room (workspace) and return its room ID.
    /// Tags the room with a custom state event so it can be identified as
    /// a workspace when listing rooms.
    #[wasm_bindgen(js_name = createRoom)]
    pub async fn create_room(&self, name: String) -> Result<String, JsValue> {
        let mut request = CreateRoomRequest::new();
        request.name = Some(name);
        request.preset =
            Some(matrix_sdk::ruma::api::client::room::create_room::v3::RoomPreset::PrivateChat);

        let room = self
            .client
            .create_room(request)
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to create room: {e}")))?;

        // Enable E2E (Megolm) encryption before the room carries any workspace
        // data. Matrix rooms are NOT encrypted by default — without this the
        // homeserver would see every cell update in plaintext. We fail room
        // creation if encryption can't be turned on rather than silently
        // creating an unencrypted workspace. See ARCHITECTURE_REVIEW.md §4.2.
        room.enable_encryption().await.map_err(|e| {
            JsValue::from_str(&format!("Failed to enable end-to-end encryption: {e}"))
        })?;

        // Tag the room as a workspace
        let marker = WorkspaceMarkerEventContent { workspace: true };
        room.send_state_event_for_key("", marker)
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to tag room as workspace: {e}")))?;

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

    /// List joined rooms. Returns a JSON array of `{id, name, isWorkspace}` objects.
    /// The `isWorkspace` flag is true if the room has a `io.tidework.workspace`
    /// state event, allowing the UI to filter out system rooms.
    #[wasm_bindgen(js_name = listRooms)]
    pub async fn list_rooms(&self) -> String {
        let workspace_event_type = StateEventType::from(WORKSPACE_STATE_TYPE.to_owned());

        let mut rooms = Vec::new();
        for room in self.client.joined_rooms() {
            let is_workspace = room
                .get_state_event(workspace_event_type.clone(), "")
                .await
                .ok()
                .flatten()
                .and_then(|raw| {
                    // Serialize the raw event to JSON, then inspect the content
                    let json: serde_json::Value = serde_json::to_value(&raw).ok()?;
                    json.get("content")?.get("workspace")?.as_bool()
                })
                .unwrap_or(false);

            rooms.push(serde_json::json!({
                "id": room.room_id().to_string(),
                "name": room.name().unwrap_or_default(),
                "isWorkspace": is_workspace,
            }));
        }
        serde_json::to_string(&rooms).unwrap_or_else(|_| "[]".to_string())
    }

    /// List rooms the user has been invited to but not yet joined.
    /// Returns a JSON array of `{id, name, inviter}` objects.
    /// The UI can display these as pending workspace invitations.
    #[wasm_bindgen(js_name = listInvitedRooms)]
    pub async fn list_invited_rooms(&self) -> String {
        let mut rooms = Vec::new();
        for room in self.client.invited_rooms() {
            let name = room.name().unwrap_or_default();
            // Try to find who sent the invite from the room's invite state
            let inviter = room
                .invite_details()
                .await
                .ok()
                .and_then(|details| details.inviter.map(|m| m.user_id().to_string()))
                .unwrap_or_default();

            rooms.push(serde_json::json!({
                "id": room.room_id().to_string(),
                "name": name,
                "inviter": inviter,
            }));
        }
        serde_json::to_string(&rooms).unwrap_or_else(|_| "[]".to_string())
    }

    /// Decline a room invitation (leave the invited room).
    #[wasm_bindgen(js_name = declineInvite)]
    pub async fn decline_invite(&self, room_id: String) -> Result<(), JsValue> {
        let room_id: OwnedRoomId = room_id
            .as_str()
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid room ID"))?;

        let room = self
            .client
            .get_room(&room_id)
            .ok_or_else(|| JsValue::from_str("Room not found"))?;

        room.leave()
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to decline invite: {e}")))?;

        Ok(())
    }

    /// Return session data as a JSON string so the JS side can persist it
    /// and later call `restore()` without needing the password again.
    ///
    /// The JSON contains: `homeserverUrl`, `userId`, `deviceId`, `accessToken`.
    #[wasm_bindgen(js_name = sessionData)]
    pub fn session_data(&self) -> Result<String, JsValue> {
        serialize_session(&self.client, &self.store_name)
            .ok_or_else(|| JsValue::from_str("No active session"))
    }

    /// Re-persist the session blob whenever the SDK refreshes the OAuth
    /// tokens, so a later reload restores with a *live* access/refresh token
    /// instead of the dead one captured at sign-in. Without this, refresh
    /// works in-memory for the current page but is lost on reload — the very
    /// gap that booted users and tripped the verify gate.
    ///
    /// `on_tokens` is called with the fresh `sessionData()` JSON string; the
    /// JS side overwrites the stored account blob. Spawns a task — does not
    /// block. Idempotent enough to call once per restored/signed-in session.
    #[wasm_bindgen(js_name = startTokenPersistence)]
    pub fn start_token_persistence(&self, on_tokens: js_sys::Function) {
        let client = self.client.clone();
        let store_name = self.store_name.clone();
        let mut changes = client.subscribe_to_session_changes();

        spawn_local(async move {
            loop {
                match changes.recv().await {
                    Ok(SessionChange::TokensRefreshed) => {
                        if let Some(blob) = serialize_session(&client, &store_name) {
                            let _ = on_tokens.call1(&JsValue::NULL, &JsValue::from_str(&blob));
                        }
                    }
                    // UnknownToken (refresh itself failed / token revoked) — the
                    // request layer surfaces the auth error to the UI; nothing to
                    // persist here.
                    Ok(_) => {}
                    // Lagged past the buffer or the sender dropped — stop.
                    Err(_) => break,
                }
            }
        });
    }

    /// Restore a previously saved session without re-entering the password.
    ///
    /// Accepts a homeserver URL plus the JSON blob returned by `sessionData()`.
    /// Builds a new `Client`, calls the SDK's `restore_session()`, and runs
    /// an initial sync so the SDK knows about joined rooms.
    #[wasm_bindgen]
    pub async fn restore(
        homeserver_url: String,
        session_json: String,
    ) -> Result<MatrixSession, JsValue> {
        #[derive(Deserialize)]
        struct SavedSession {
            #[serde(rename = "userId")]
            user_id: String,
            #[serde(rename = "deviceId")]
            device_id: String,
            #[serde(rename = "accessToken")]
            access_token: String,
            /// Absent in sessions saved before stores were persisted.
            #[serde(rename = "storeName", default)]
            store_name: Option<String>,
            /// "password" (default when absent — legacy blobs) or "oauth".
            #[serde(default)]
            kind: Option<String>,
            /// OAuth only: refresh token + the dynamically-registered client id.
            #[serde(rename = "refreshToken", default)]
            refresh_token: Option<String>,
            #[serde(rename = "clientId", default)]
            client_id: Option<String>,
        }

        let saved: SavedSession = serde_json::from_str(&session_json)
            .map_err(|e| JsValue::from_str(&format!("Invalid session JSON: {e}")))?;

        // Legacy sessions (saved before stores were persisted) had in-memory
        // crypto that is already gone — give them a deterministic store so
        // future reloads at least stop regenerating the device identity.
        let store_name = saved.store_name.clone().unwrap_or_else(|| {
            format!(
                "tw-legacy-{}-{}",
                sanitize_store_key(&saved.user_id),
                sanitize_store_key(&saved.device_id)
            )
        });

        let client = Client::builder()
            .homeserver_url(&homeserver_url)
            .indexeddb_store(&store_name, None)
            .with_encryption_settings(default_encryption_settings())
            // Share encrypted room history with invitees (MSC4268) so new
            // collaborators can decrypt workspace data written before they
            // joined; mirrors MatrixClient::new. Requires a homeserver that
            // exposes the inviter in the invite stripped state — prod's Synapse
            // does (see the collaborator_history_matrix integration test).
            .with_enable_share_history_on_invite(true)
            // OAuth (MAS) access tokens are short-lived; without this the SDK
            // never spends the refresh token and every request after expiry
            // 401s with M_UNKNOWN_TOKEN — booting the user and tripping the
            // verify gate on the next reload. Refreshed tokens are persisted
            // by `startTokenPersistence`.
            .handle_refresh_tokens()
            .build()
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to connect: {e}")))?;

        let user_id: OwnedUserId = saved
            .user_id
            .as_str()
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid user ID in session"))?;
        let device_id: OwnedDeviceId = saved.device_id.into();
        let meta = SessionMeta {
            user_id: user_id.clone(),
            device_id,
        };

        let sdk_session: AuthSession = if saved.kind.as_deref() == Some("oauth") {
            let client_id = saved
                .client_id
                .ok_or_else(|| JsValue::from_str("OAuth session blob missing clientId"))?;
            AuthSession::OAuth(Box::new(SdkOAuthSession {
                client_id: ClientId::new(client_id),
                user: UserSession {
                    meta,
                    tokens: SessionTokens {
                        access_token: saved.access_token,
                        refresh_token: saved.refresh_token,
                    },
                },
            }))
        } else {
            AuthSession::Matrix(matrix_sdk::authentication::matrix::MatrixSession {
                meta,
                tokens: SessionTokens {
                    access_token: saved.access_token,
                    refresh_token: None,
                },
            })
        };

        client
            .restore_session(sdk_session)
            .await
            .map_err(|e| JsValue::from_str(&format!("Session restore failed: {e}")))?;

        Ok(MatrixSession {
            client,
            user_id: Some(user_id),
            store_name: Some(store_name),
        })
    }

    // ── OAuth 2.0 / next-gen auth login (ADR 0002 phase A) ───────────────

    /// Whether `homeserver_url` delegates auth to an OAuth 2.0 authorization
    /// server (MSC3861 / next-gen auth, e.g. Synapse+MAS). Drives the sign-in
    /// page's branching: SSO flow when true, classic password form otherwise.
    /// Uses a throwaway in-memory client — this is only a metadata probe.
    #[wasm_bindgen(js_name = homeserverSupportsOauth)]
    pub async fn homeserver_supports_oauth(homeserver_url: String) -> Result<bool, JsValue> {
        let client = Client::builder()
            .homeserver_url(&homeserver_url)
            .build()
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to connect: {e}")))?;
        Ok(client.oauth().server_metadata().await.is_ok())
    }

    /// Begin an OAuth 2.0 login against a homeserver that delegates auth to
    /// MAS (MSC3861): builds a client bound to a fresh per-device store,
    /// dynamically registers this app with the authorization server, and
    /// returns the authorization URL.
    ///
    /// The pending client is held in memory — the PKCE verifier lives inside
    /// it — so `finishOauthLogin` must run in the **same page**. Open the URL
    /// in a popup (not a full-page redirect, which would destroy the WASM
    /// instance mid-flow) and post the final redirect URL back.
    #[wasm_bindgen(js_name = startOauthLogin)]
    pub async fn start_oauth_login(
        homeserver_url: String,
        redirect_uri: String,
    ) -> Result<String, JsValue> {
        let store_name = new_store_name("oauth");
        let client = Client::builder()
            .homeserver_url(&homeserver_url)
            .indexeddb_store(&store_name, None)
            .with_encryption_settings(default_encryption_settings())
            // Share encrypted room history with invitees (MSC4268) so new
            // collaborators can decrypt workspace data written before they
            // joined; mirrors MatrixClient::new. Requires a homeserver that
            // exposes the inviter in the invite stripped state — prod's Synapse
            // does (see the collaborator_history_matrix integration test).
            .with_enable_share_history_on_invite(true)
            // OAuth (MAS) access tokens are short-lived; without this the SDK
            // never spends the refresh token and every request after expiry
            // 401s with M_UNKNOWN_TOKEN — booting the user and tripping the
            // verify gate on the next reload. Refreshed tokens are persisted
            // by `startTokenPersistence`.
            .handle_refresh_tokens()
            .build()
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to connect: {e}")))?;

        let redirect: url::Url = redirect_uri
            .parse()
            .map_err(|e| JsValue::from_str(&format!("Invalid redirect URI: {e}")))?;

        // OIDC dynamic client registration: a public web client (no secret —
        // PKCE carries the proof), rooted at the redirect URI's origin.
        let client_uri = {
            let mut u = redirect.clone();
            u.set_path("/");
            u.set_query(None);
            u.set_fragment(None);
            u
        };
        let metadata_json = serde_json::json!({
            "client_name": "TideWork",
            "client_uri": client_uri,
            "application_type": "web",
            "redirect_uris": [redirect],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        });
        let metadata: Raw<ClientMetadata> = Raw::from_json_string(metadata_json.to_string())
            .map_err(|e| JsValue::from_str(&format!("Invalid client metadata: {e}")))?;
        let registration_data: ClientRegistrationData = metadata.into();

        let auth_data = client
            .oauth()
            .login(redirect, None, Some(registration_data), None)
            .build()
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to start OAuth login: {e}")))?;

        PENDING_OAUTH.with(|p| *p.borrow_mut() = Some((client, store_name)));
        Ok(auth_data.url.to_string())
    }

    /// Complete an OAuth login with the URL the popup was finally redirected
    /// to (it carries the authorization code + state). Exchanges the code for
    /// tokens on the client started by `startOauthLogin` and returns the
    /// logged-in session.
    #[wasm_bindgen(js_name = finishOauthLogin)]
    pub async fn finish_oauth_login(redirected_url: String) -> Result<MatrixSession, JsValue> {
        let (client, store_name) = PENDING_OAUTH
            .with(|p| p.borrow_mut().take())
            .ok_or_else(|| JsValue::from_str("No OAuth login in progress"))?;

        let url: url::Url = redirected_url
            .parse()
            .map_err(|e| JsValue::from_str(&format!("Invalid redirect URL: {e}")))?;

        client
            .oauth()
            .finish_login(url.into())
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to finish OAuth login: {e}")))?;

        let user_id = client.user_id().map(|u| u.to_owned());
        Ok(MatrixSession {
            client,
            user_id,
            store_name: Some(store_name),
        })
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

    /// Start a session-level sync loop that fires `on_change` whenever the
    /// room list changes (new invites, new joins, rooms left, etc.).
    ///
    /// This is intended for the Workspaces page where no workspace sync is
    /// running.  The callback receives no data — the JS side should call
    /// `listRooms()` / `listInvitedRooms()` to refresh.
    ///
    /// This spawns an async task — it does NOT block.
    #[wasm_bindgen(js_name = startSessionSync)]
    pub fn start_session_sync(&self, on_change: js_sys::Function) {
        let client = self.client.clone();

        spawn_local(async move {
            let settings = SyncSettings::default();

            let _ = client
                .sync_with_callback(settings, |response| {
                    let on_change = on_change.clone();

                    async move {
                        // Fire when ANY room activity happens (invites, joins, leaves)
                        let has_changes = !response.rooms.invited.is_empty()
                            || !response.rooms.joined.is_empty()
                            || !response.rooms.left.is_empty();

                        if has_changes {
                            let _ = on_change.call0(&JsValue::NULL);
                        }

                        LoopCtrl::Continue
                    }
                })
                .await;
        });
    }

    // ── Device verification (ADR 0001 Phase D-3) ────────────────────────

    /// Start verifying THIS device against another of the user's signed-in
    /// devices (the new device's "verify with another device"). Sends an SAS
    /// verification request to the user's other devices and returns a handle to
    /// drive the emoji flow. Errors if the account has no cross-signing identity
    /// yet (the user should use their master key instead).
    #[wasm_bindgen(js_name = requestSelfVerification)]
    pub async fn request_self_verification(&self) -> Result<DeviceVerification, JsValue> {
        let user_id = self
            .client
            .user_id()
            .ok_or_else(|| JsValue::from_str("Not logged in"))?
            .to_owned();
        let identity = self
            .client
            .encryption()
            .get_user_identity(&user_id)
            .await
            .map_err(|e| JsValue::from_str(&format!("Identity lookup failed: {e}")))?
            .ok_or_else(|| {
                JsValue::from_str("No cross-signing identity yet — use your master key instead")
            })?;
        let request = identity
            .request_verification()
            .await
            .map_err(|e| JsValue::from_str(&format!("Verification request failed: {e}")))?;
        Ok(DeviceVerification {
            client: self.client.clone(),
            user_id,
            flow_id: request.flow_id().to_owned(),
            we_started: true,
            sas: Rc::new(RefCell::new(None)),
        })
    }

    /// Build a handle for an INCOMING verification request (receiver side),
    /// identified by its flow id (surfaced by `startVerificationListener`).
    /// Returns null if no such in-flight request exists.
    #[wasm_bindgen(js_name = verificationForFlow)]
    pub async fn verification_for_flow(&self, flow_id: String) -> Option<DeviceVerification> {
        let user_id = self.client.user_id()?.to_owned();
        self.client
            .encryption()
            .get_verification_request(&user_id, &flow_id)
            .await?;
        Some(DeviceVerification {
            client: self.client.clone(),
            user_id,
            flow_id,
            we_started: false,
            sas: Rc::new(RefCell::new(None)),
        })
    }

    /// Register a listener that records INCOMING self-verification requests
    /// (e.g. a new device asking to verify) while a sync is running. The UI
    /// polls `pendingVerificationFlow()` to pick them up. Call once per session.
    #[wasm_bindgen(js_name = startVerificationListener)]
    pub fn start_verification_listener(&self) {
        use matrix_sdk::ruma::events::key::verification::request::ToDeviceKeyVerificationRequestEvent;
        let handle =
            self.client
                .add_event_handler(|ev: ToDeviceKeyVerificationRequestEvent| async move {
                    let flow_id = ev.content.transaction_id.to_string();
                    PENDING_VERIFICATION.with(|p| *p.borrow_mut() = Some(flow_id));
                });
        // Listener lives for the session.
        std::mem::forget(handle);
    }

    /// Take the flow id of a pending incoming verification request, if any
    /// (clears it). The UI polls this to know when to show the verify prompt.
    #[wasm_bindgen(js_name = pendingVerificationFlow)]
    pub fn pending_verification_flow(&self) -> Option<String> {
        PENDING_VERIFICATION.with(|p| p.borrow_mut().take())
    }

    /// A single short-timeout sync, for driving an interactive flow (e.g. the
    /// verify screen) on a device that has no continuous sync running yet.
    /// Bounded so it returns promptly instead of long-polling for ~30s.
    #[wasm_bindgen(js_name = pumpSync)]
    pub async fn pump_sync(&self) -> Result<(), JsValue> {
        let settings = SyncSettings::default().timeout(Duration::from_millis(500));
        self.client
            .sync_once(settings)
            .await
            .map_err(|e| JsValue::from_str(&format!("Sync failed: {e}")))?;
        Ok(())
    }
}

thread_local! {
    /// Flow id of the most recent incoming verification request, recorded by the
    /// `startVerificationListener` handler and drained by the UI. wasm is
    /// single-threaded, so a thread-local avoids threading state through every
    /// `MatrixSession` constructor.
    static PENDING_VERIFICATION: RefCell<Option<String>> = const { RefCell::new(None) };

    /// The client (+ its store name) of an OAuth login in progress, parked
    /// between `startOauthLogin` and `finishOauthLogin`. The PKCE verifier
    /// lives inside this client's memory, so the finish call must reuse the
    /// exact instance that built the authorization URL.
    static PENDING_OAUTH: RefCell<Option<(Client, String)>> = const { RefCell::new(None) };
}

// ── Device verification handle ──────────────────────────────────────

/// An in-progress SAS (emoji) device verification, exposed to JS.
///
/// Drive it with `run(onChange)`, which advances the protocol plumbing on each
/// sync and reports the state (`"pending"` → `"started"` → `"emoji"` → `"done"`
/// / `"cancelled"`). Once state is `"emoji"`, read `emoji()`, have the user
/// confirm the two devices show the same symbols, then call `confirm()`.
#[wasm_bindgen]
pub struct DeviceVerification {
    client: Client,
    user_id: OwnedUserId,
    flow_id: String,
    /// Did we initiate (new device) vs. receive the request (existing device)?
    we_started: bool,
    sas: Rc<RefCell<Option<SasVerification>>>,
}

#[wasm_bindgen]
impl DeviceVerification {
    #[wasm_bindgen(js_name = flowId)]
    pub fn flow_id(&self) -> String {
        self.flow_id.clone()
    }

    /// Accept the incoming request (receiver side). No-op once SAS has started.
    #[wasm_bindgen]
    pub async fn accept(&self) -> Result<(), JsValue> {
        if let Some(req) = self
            .client
            .encryption()
            .get_verification_request(&self.user_id, &self.flow_id)
            .await
        {
            req.accept()
                .await
                .map_err(|e| JsValue::from_str(&format!("Accept failed: {e}")))?;
        }
        Ok(())
    }

    /// The seven SAS emoji once key exchange completes, as a JSON array of
    /// `{symbol, description}`. Empty array until the `"emoji"` state.
    #[wasm_bindgen]
    pub fn emoji(&self) -> String {
        let guard = self.sas.borrow();
        let Some(sas) = guard.as_ref() else {
            return "[]".to_string();
        };
        match sas.emoji() {
            Some(emojis) => {
                let arr: Vec<serde_json::Value> = emojis
                    .iter()
                    .map(
                        |e| serde_json::json!({ "symbol": e.symbol, "description": e.description }),
                    )
                    .collect();
                serde_json::to_string(&arr).unwrap_or_else(|_| "[]".to_string())
            }
            None => "[]".to_string(),
        }
    }

    /// Confirm the emoji match (both sides call this after the user compares).
    #[wasm_bindgen]
    pub async fn confirm(&self) -> Result<(), JsValue> {
        let sas = self.sas.borrow().clone();
        if let Some(sas) = sas {
            sas.confirm()
                .await
                .map_err(|e| JsValue::from_str(&format!("Confirm failed: {e}")))?;
        }
        Ok(())
    }

    /// Cancel the verification (e.g., the emoji don't match).
    #[wasm_bindgen]
    pub async fn cancel(&self) -> Result<(), JsValue> {
        let sas = self.sas.borrow().clone();
        if let Some(sas) = sas {
            let _ = sas.cancel().await;
        } else if let Some(req) = self
            .client
            .encryption()
            .get_verification_request(&self.user_id, &self.flow_id)
            .await
        {
            let _ = req.cancel().await;
        }
        Ok(())
    }

    #[wasm_bindgen(js_name = isDone)]
    pub fn is_done(&self) -> bool {
        self.sas
            .borrow()
            .as_ref()
            .map(|s| s.is_done())
            .unwrap_or(false)
    }

    /// Advance the flow by ONE protocol step (start/accept the SAS as the state
    /// allows) and return the current state: `"pending"` → `"started"` →
    /// `"emoji"` → `"done"` / `"cancelled"`. Does NOT sync — the caller is
    /// responsible for syncing first (the new device pumps its own bounded sync;
    /// an existing device relies on the sync already running in the app), which
    /// keeps this off the single-sync-loop critical path.
    #[wasm_bindgen]
    pub async fn advance(&self) -> String {
        let have_sas = self.sas.borrow().is_some();
        if !have_sas {
            if let Some(req) = self
                .client
                .encryption()
                .get_verification_request(&self.user_id, &self.flow_id)
                .await
            {
                if req.is_cancelled() {
                    return "cancelled".to_string();
                }
                if self.we_started {
                    if req.is_ready() {
                        if let Ok(Some(s)) = req.start_sas().await {
                            *self.sas.borrow_mut() = Some(s);
                        }
                    }
                } else if let Some(Verification::SasV1(s)) = self
                    .client
                    .encryption()
                    .get_verification(&self.user_id, &self.flow_id)
                    .await
                {
                    let _ = s.accept().await;
                    *self.sas.borrow_mut() = Some(s);
                }
            }
        }
        self.state_string()
    }

    /// Current state without advancing.
    #[wasm_bindgen]
    pub fn state(&self) -> String {
        self.state_string()
    }
}

impl DeviceVerification {
    fn state_string(&self) -> String {
        let guard = self.sas.borrow();
        match guard.as_ref() {
            Some(sas) if sas.is_done() => "done",
            Some(sas) if sas.is_cancelled() => "cancelled",
            Some(sas) if sas.emoji().is_some() => "emoji",
            Some(_) => "started",
            None => "pending",
        }
        .to_string()
    }
}

// ── Connected Workspace ─────────────────────────────────────────────

/// Key for coalescing pending cell updates: (table_id, row_id, column_id).
type CellKey = (String, String, String);

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
    /// Count of room events that could not be decrypted (no key) during cold
    /// start / sync. Surfaced to the UI instead of being silently dropped —
    /// see `docs/adr/0001-e2e-key-management.md` / review §4.2.
    undecryptable: Rc<Cell<u32>>,
    /// Coalescing send queue: the latest pending `CellUpdate` per cell, keyed by
    /// (table, row, column). Rapid edits to the same cell (e.g. repeatedly
    /// dragging a kanban card) collapse to a single send, and a debounced
    /// background task drains this so write bursts don't trip the homeserver
    /// rate limit (`M_LIMIT_EXCEEDED`). Local state is applied immediately, so
    /// queueing the network send never delays the UI.
    pending: Rc<RefCell<HashMap<CellKey, CellUpdate>>>,
    /// Guard: whether a debounced flush task is currently scheduled/running.
    flushing: Rc<Cell<bool>>,
}

#[wasm_bindgen]
impl ConnectedWorkspace {
    /// Create a connected workspace from a session and room ID.
    ///
    /// This is an async factory method that:
    /// 1. Verifies the room exists
    /// 2. Fetches room history (backwards pagination)
    /// 3. Replays all cell-update events to reconstruct workspace state
    #[wasm_bindgen]
    pub async fn create(
        session: &MatrixSession,
        room_id: String,
    ) -> Result<ConnectedWorkspace, JsValue> {
        let room_id: OwnedRoomId = room_id
            .as_str()
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid room ID"))?;

        let client = session.inner().clone();

        // Verify the room exists in our session
        let room = client
            .get_room(&room_id)
            .ok_or_else(|| JsValue::from_str("Room not found — did you run initialSync?"))?;

        let mut workspace = Workspace::new(room_id.to_string());

        // ── Fetch room history and replay events ──────────────────────
        // Workspace-level cold start (review §4.4): paginate backwards from the
        // end of the timeline and replay every cell-update event through
        // `Workspace::apply_update`, which routes user data, schema and view
        // updates to the right place. This is intentionally distinct from the
        // raw-table `TimelinePaginator` in `tables-over-matrix` — that engine
        // materializes bare tables and has no notion of system tables. Values
        // are LWW so order-independent; per-cell history is bounded by the
        // order-based bumping wired in at write time (§4.3).
        let mut undecryptable_count = 0u32;
        let mut from_token: Option<String> = None;
        loop {
            let mut options = MessagesOptions::backward();
            if let Some(ref token) = from_token {
                options = options.from(token.as_str());
            }

            let response = room
                .messages(options)
                .await
                .map_err(|e| JsValue::from_str(&format!("Failed to fetch room history: {e}")))?;

            if response.chunk.is_empty() {
                break;
            }

            for timeline_event in &response.chunk {
                if let Ok(json_str) = serde_json::to_string(timeline_event.raw().json()) {
                    if let Some(received) = MatrixClient::extract_cell_update(&json_str) {
                        // Attach origin_server_ts as the LWW tiebreaker.
                        let _ = workspace.apply_update(received.into_update());
                    } else if MatrixClient::is_undecryptable_event(&json_str) {
                        // History we can't decrypt (no key) — count it so the UI
                        // can warn instead of silently materializing partial state.
                        undecryptable_count += 1;
                    }
                }
            }

            match response.end {
                Some(token) => from_token = Some(token),
                None => break, // No more pages
            }
        }

        Ok(ConnectedWorkspace {
            inner: Rc::new(RefCell::new(workspace)),
            client,
            room_id,
            undecryptable: Rc::new(Cell::new(undecryptable_count)),
            pending: Rc::new(RefCell::new(HashMap::new())),
            flushing: Rc::new(Cell::new(false)),
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
        let undecryptable = Rc::clone(&self.undecryptable);

        spawn_local(async move {
            let settings = SyncSettings::default();

            let _ = client
                .sync_with_callback(settings, |response| {
                    let workspace = Rc::clone(&workspace);
                    let undecryptable = Rc::clone(&undecryptable);
                    let room_id = room_id.clone();
                    let on_change = on_change.clone();

                    async move {
                        // Look for our room in the sync response
                        if let Some(joined) = response.rooms.joined.get(&room_id) {
                            let mut changed = false;

                            for raw_event in &joined.timeline.events {
                                // Try to extract our custom event
                                if let Ok(json_str) = serde_json::to_string(raw_event.raw().json())
                                {
                                    if let Some(received) =
                                        MatrixClient::extract_cell_update(&json_str)
                                    {
                                        let mut ws = workspace.borrow_mut();
                                        // Attach origin_server_ts as the LWW tiebreaker.
                                        let _ = ws.apply_update(received.into_update());
                                        changed = true;
                                    } else if MatrixClient::is_undecryptable_event(&json_str) {
                                        undecryptable.set(undecryptable.get() + 1);
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

        serde_json::to_string(&user_ids).map_err(|_| JsValue::from_str("Serialization failed"))
    }

    // ── Table operations (delegated to inner workspace + Matrix send) ──

    /// Create a table. Returns the cell updates as JSON.
    #[wasm_bindgen(js_name = createTable)]
    pub async fn create_table(&self, definition_json: &str) -> Result<String, JsValue> {
        let definition: crate::schema::TableDefinition = serde_json::from_str(definition_json)
            .map_err(|_| JsValue::from_str("Invalid table definition"))?;

        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.create_table(definition)
                .map_err(|_| JsValue::from_str("Failed to create table"))?
        };

        // Send updates to Matrix
        self.send_updates(&updates).await?;

        serde_json::to_string(&updates).map_err(|_| JsValue::from_str("Serialization failed"))
    }

    /// Update a cell. Applies locally immediately (optimistic) and enqueues the
    /// resulting updates for a debounced, coalesced background send.
    ///
    /// The network send is intentionally *not* awaited here: it would otherwise
    /// block the write path and, under rapid edits (e.g. dragging kanban cards),
    /// fire a burst of one-event-per-change requests that trips the homeserver
    /// rate limit. The flush task in [`Self::schedule_flush`] coalesces repeated
    /// writes to the same cell and paces sends with backoff instead.
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

        // Apply locally and capture the updates to send: the user write plus an
        // order-based compaction bump of the stalest cell (review §4.3).
        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.update_cell_with_bump(&table_id, &row_id, &column_id, value)
                .map_err(|_| JsValue::from_str("Update failed"))?
        };

        // Enqueue for the debounced background flush rather than sending now.
        self.enqueue_updates(updates);

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
        serde_json::to_string(&rows).map_err(|_| JsValue::from_str("Serialization failed"))
    }

    /// Get table schema as JSON.
    #[wasm_bindgen(js_name = getTableSchema)]
    pub fn get_table_schema(&self, table_id: String) -> Result<String, JsValue> {
        let ws = self.inner.borrow();
        let schema = ws
            .get_table_schema(&table_id)
            .ok_or_else(|| JsValue::from_str("Table not found"))?;
        serde_json::to_string(&schema).map_err(|_| JsValue::from_str("Serialization failed"))
    }

    /// List all tables.
    #[wasm_bindgen(js_name = listTables)]
    pub fn list_tables(&self) -> String {
        let ws = self.inner.borrow();
        let tables = ws.list_tables();
        serde_json::to_string(&tables).unwrap_or_else(|_| "[]".to_string())
    }

    /// Whether the underlying Matrix room is end-to-end encrypted. The UI uses
    /// this to show an honest encryption indicator instead of a hard-coded
    /// claim. See ARCHITECTURE_REVIEW.md §4.2.
    #[wasm_bindgen(js_name = isEncrypted)]
    pub fn is_encrypted(&self) -> bool {
        self.client
            .get_room(&self.room_id)
            .map(|room| room.encryption_state().is_encrypted())
            .unwrap_or(false)
    }

    /// Number of room events that could not be decrypted (no key) during cold
    /// start / sync. The UI surfaces this as a warning rather than silently
    /// dropping the data (otherwise the workspace would materialize wrong
    /// state). See `docs/adr/0001-e2e-key-management.md` / review §4.2.
    #[wasm_bindgen(js_name = undecryptableCount)]
    pub fn undecryptable_count(&self) -> u32 {
        self.undecryptable.get()
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

        serde_json::to_string(&updates).map_err(|_| JsValue::from_str("Serialization failed"))
    }

    /// Get view configuration as JSON.
    #[wasm_bindgen(js_name = getView)]
    pub fn get_view(&self, view_id: String) -> Result<String, JsValue> {
        let ws = self.inner.borrow();
        let view = ws
            .get_view(&view_id)
            .ok_or_else(|| JsValue::from_str("View not found"))?;
        serde_json::to_string(&view).map_err(|_| JsValue::from_str("Serialization failed"))
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
    pub async fn add_column(&self, table_id: String, column_json: &str) -> Result<(), JsValue> {
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

    /// Reorder a table's columns. `ordered_ids_json` is a JSON array of column
    /// ids in the new left-to-right order.
    #[wasm_bindgen(js_name = reorderColumns)]
    pub async fn reorder_columns(
        &self,
        table_id: String,
        ordered_ids_json: &str,
    ) -> Result<(), JsValue> {
        let ordered: Vec<String> = serde_json::from_str(ordered_ids_json)
            .map_err(|_| JsValue::from_str("Invalid column id list"))?;

        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.reorder_columns(&table_id, &ordered)
                .map_err(|_| JsValue::from_str("Failed to reorder columns"))?
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
    /// Merge `updates` into the coalescing send queue (highest timestamp wins
    /// per cell, since values are LWW) and ensure a flush task is running.
    fn enqueue_updates(&self, updates: Vec<CellUpdate>) {
        {
            let mut pending = self.pending.borrow_mut();
            for update in updates {
                merge_pending(&mut pending, update);
            }
        }
        self.schedule_flush();
    }

    /// Start the debounced background flush task, unless one is already running.
    ///
    /// WASM is single-threaded and cooperative, so there is no interleaving
    /// between this guard check and the task's `flushing.set(false)` on exit:
    /// any [`enqueue_updates`](Self::enqueue_updates) after the task ends sees
    /// `flushing == false` and schedules a fresh task.
    fn schedule_flush(&self) {
        if self.flushing.get() {
            return;
        }
        self.flushing.set(true);

        let client = self.client.clone();
        let room_id = self.room_id.clone();
        let pending = Rc::clone(&self.pending);
        let flushing = Rc::clone(&self.flushing);

        spawn_local(async move {
            flush_pending(client, room_id, pending, flushing).await;
        });
    }

    /// Send a batch of CellUpdates to the Matrix room.
    async fn send_updates(&self, updates: &[CellUpdate]) -> Result<(), JsValue> {
        let room = self
            .client
            .get_room(&self.room_id)
            .ok_or_else(|| JsValue::from_str("Room not found"))?;

        // Fail closed: never emit workspace data into a room that is not
        // end-to-end encrypted. The SDK encrypts `room.send` automatically once
        // the room is encrypted, but it would happily send plaintext otherwise.
        // See ARCHITECTURE_REVIEW.md §4.2.
        if !room.encryption_state().is_encrypted() {
            return Err(JsValue::from_str(
                "Refusing to send: this workspace room is not end-to-end encrypted",
            ));
        }

        for update in updates {
            let content: tables_over_matrix::CellUpdateEventContent = update.clone().into();
            room.send(content)
                .await
                .map_err(|e| JsValue::from_str(&format!("Failed to send update: {e}")))?;
        }

        Ok(())
    }
}

/// Insert `update` into the coalescing queue, keeping the entry with the highest
/// timestamp per cell. Values are last-writer-wins, so only the latest write to
/// a cell needs to reach the server — superseded intermediate writes (and stale
/// compaction bumps) are dropped.
fn merge_pending(pending: &mut HashMap<CellKey, CellUpdate>, update: CellUpdate) {
    let key = (
        update.table_id.clone(),
        update.row_id.clone(),
        update.column_id.clone(),
    );
    match pending.get(&key) {
        Some(existing) if existing.timestamp >= update.timestamp => {}
        _ => {
            pending.insert(key, update);
        }
    }
}

/// Debounced, coalescing flush loop for the pending send queue.
///
/// Each iteration sleeps a short window (so a flurry of edits coalesces), then
/// drains and sends the queue. On send failure — notably a `429`
/// `M_LIMIT_EXCEEDED` rate-limit — the failed updates are re-queued and the next
/// window backs off exponentially, so the burst is paced out and the error is
/// never surfaced to the user. The loop exits once the queue is empty; a later
/// enqueue starts a fresh task (see [`ConnectedWorkspace::schedule_flush`]).
async fn flush_pending(
    client: Client,
    room_id: OwnedRoomId,
    pending: Rc<RefCell<HashMap<CellKey, CellUpdate>>>,
    flushing: Rc<Cell<bool>>,
) {
    const DEBOUNCE_MS: u64 = 300;
    const MAX_BACKOFF_MS: u64 = 8_000;
    let mut backoff_ms = DEBOUNCE_MS;

    loop {
        matrix_sdk::sleep::sleep(Duration::from_millis(backoff_ms)).await;

        let batch: Vec<CellUpdate> = {
            let mut p = pending.borrow_mut();
            p.drain().map(|(_, v)| v).collect()
        };

        if batch.is_empty() {
            flushing.set(false);
            return;
        }

        match send_batch(&client, &room_id, batch).await {
            Ok(()) => backoff_ms = DEBOUNCE_MS,
            Err(failed) => {
                let mut p = pending.borrow_mut();
                for update in failed {
                    merge_pending(&mut p, update);
                }
                backoff_ms = backoff_ms.saturating_mul(2).min(MAX_BACKOFF_MS);
            }
        }
    }
}

/// Send a coalesced batch of updates, returning the ones that failed (so the
/// caller can re-queue and retry). Fails closed on a non-encrypted room.
async fn send_batch(
    client: &Client,
    room_id: &OwnedRoomId,
    batch: Vec<CellUpdate>,
) -> Result<(), Vec<CellUpdate>> {
    let Some(room) = client.get_room(room_id) else {
        // Room not available yet; retry the whole batch on the next pass.
        return Err(batch);
    };

    // Fail closed: never emit workspace data into a non-encrypted room. This is
    // a permanent condition (not a transient send error), so drop rather than
    // retry forever. See ARCHITECTURE_REVIEW.md §4.2.
    if !room.encryption_state().is_encrypted() {
        return Ok(());
    }

    let mut failed = Vec::new();
    for update in batch {
        let content: tables_over_matrix::CellUpdateEventContent = update.clone().into();
        if room.send(content).await.is_err() {
            failed.push(update);
        }
    }

    if failed.is_empty() {
        Ok(())
    } else {
        Err(failed)
    }
}
