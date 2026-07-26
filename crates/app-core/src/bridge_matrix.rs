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

use crate::snapshot::{backfill_caught_up, WorkspaceSnapshot, SNAPSHOT_VERSION};
use crate::workspace::Workspace;
use matrix_sdk::crypto::CollectStrategy;
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
        // At-rest encryption (issue c72ec5df): when supplied (derived from the
        // master secret), the IndexedDB store is encrypted at rest. `None` =
        // plaintext (today's behavior); supplied by the unlock-first TS flow.
        store_passphrase: Option<String>,
    ) -> Result<MatrixSession, JsValue> {
        let store_name = new_store_name(&username);
        let client = Client::builder()
            .homeserver_url(&homeserver_url)
            .indexeddb_store(&store_name, store_passphrase.as_deref())
            .with_encryption_settings(default_encryption_settings())
            // Share Megolm keys only with devices cross-signed by their owner's
            // identity (not "all devices"): a device injected by a malicious
            // homeserver/MAS isn't signed by the user's identity, so it gets no
            // future keys — closing the future-read-via-bump reconstruction.
            // See the ADR 0001 addendum.
            .with_room_key_recipient_strategy(CollectStrategy::IdentityBasedStrategy)
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
        // At-rest encryption (issue c72ec5df): see `login`. None = plaintext.
        store_passphrase: Option<String>,
    ) -> Result<MatrixSession, JsValue> {
        use matrix_sdk::ruma::api::client::{account::register, uiaa};

        let store_name = new_store_name(&username);
        let client = Client::builder()
            .homeserver_url(&homeserver_url)
            .indexeddb_store(&store_name, store_passphrase.as_deref())
            .with_encryption_settings(default_encryption_settings())
            // Share Megolm keys only with devices cross-signed by their owner's
            // identity (not "all devices"): a device injected by a malicious
            // homeserver/MAS isn't signed by the user's identity, so it gets no
            // future keys — closing the future-read-via-bump reconstruction.
            // See the ADR 0001 addendum.
            .with_room_key_recipient_strategy(CollectStrategy::IdentityBasedStrategy)
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

    /// The account's current global display name ("" if unset). Available
    /// wherever a Matrix client exists (signed-in app / verify gate) — NOT at
    /// the at-rest unlock gate. (issue 1c8b3855)
    #[wasm_bindgen(js_name = getDisplayName)]
    pub async fn get_display_name(&self) -> Result<String, JsValue> {
        self.client
            .account()
            .get_display_name()
            .await
            .map(|n| n.unwrap_or_default())
            .map_err(|e| JsValue::from_str(&format!("Failed to fetch display name: {e}")))
    }

    /// Set the account's global Matrix display name. (issue 1c8b3855)
    #[wasm_bindgen(js_name = setDisplayName)]
    pub async fn set_display_name(&self, name: String) -> Result<(), JsValue> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(JsValue::from_str("Display name cannot be empty"));
        }
        self.client
            .account()
            .set_display_name(Some(trimmed))
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to set display name: {e}")))
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

    /// Enable Secure Backup + Recovery keyed by a **passphrase** instead of a
    /// random recovery key — the basis for passkey / WebAuthn-PRF custody: the
    /// JS side derives a stable secret from the passkey's PRF output and passes
    /// it here. The returned recovery key still works as a break-glass fallback;
    /// a later device unlocks by passing the **same passphrase** to
    /// `recoverWithKey` (which accepts a passphrase or a recovery key).
    #[wasm_bindgen(js_name = enableRecoveryWithPassphrase)]
    pub async fn enable_recovery_with_passphrase(
        &self,
        passphrase: String,
    ) -> Result<String, JsValue> {
        tables_over_matrix::enable_recovery_with_passphrase(&self.client, &passphrase)
            .await
            .map_err(|e| JsValue::from_str(&format!("{e}")))
    }

    /// Re-key Secure Backup to a **passphrase** (a passkey's PRF secret) on an
    /// account that ALREADY has recovery — the legacy-account migration to
    /// passkey custody. Call only after the device has recovered (it must hold
    /// the secrets to re-upload them). Rotates the secret-storage key and
    /// returns a fresh break-glass recovery key; the previous recovery key (the
    /// user's old master key) stops working.
    #[wasm_bindgen(js_name = resetRecoveryWithPassphrase)]
    pub async fn reset_recovery_with_passphrase(
        &self,
        passphrase: String,
    ) -> Result<String, JsValue> {
        tables_over_matrix::reset_recovery_with_passphrase(&self.client, &passphrase)
            .await
            .map_err(|e| JsValue::from_str(&format!("{e}")))
    }

    /// Reset Secure Backup to a fresh **random recovery key** (Base58), rotating
    /// the secret-storage key. For a signed-in, recovered device that wants a
    /// brand-new typed recovery key (lost the old one, or rotating). Returns the
    /// new key; the previous recovery key / passphrase / passkey stops working.
    #[wasm_bindgen(js_name = resetRecovery)]
    pub async fn reset_recovery(&self) -> Result<String, JsValue> {
        tables_over_matrix::reset_recovery(&self.client)
            .await
            .map_err(|e| JsValue::from_str(&format!("{e}")))
    }

    /// Mint a Matrix OpenID token (JSON `{ access_token, matrix_server_name }`)
    /// proving the user's identity to a third party (the billing Worker) without
    /// exposing the access token. Account-level, so it works before E2E unlock —
    /// the billing screen must be reachable from the locked gate (row_1782751521723).
    #[wasm_bindgen(js_name = requestOpenIdToken)]
    pub async fn request_openid_token(&self) -> Result<String, JsValue> {
        tables_over_matrix::request_openid_token(&self.client)
            .await
            .map_err(|e| JsValue::from_str(&format!("{e}")))
    }

    /// Restore secrets from Secure Backup so this (returning) device can decrypt
    /// history sent before it existed. `recovery_key` may be a Base58 recovery
    /// key **or a passphrase** (e.g. a passkey-PRF-derived secret) — the SDK
    /// accepts both.
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

    /// Whether the account's Secure Backup is keyed by a *passphrase* (the basis
    /// of passkey / WebAuthn-PRF custody) rather than only a raw recovery key.
    /// Read pre-unlock from unencrypted account data (the SSSS default key's KDF
    /// info), so a new device can decide whether to offer passkey unlock before
    /// it can unlock anything. Legacy accounts bootstrapped via `enableRecovery`
    /// (raw key, no passphrase) return false; accounts set up with
    /// `enableRecoveryWithPassphrase` return true. Leaks no new metadata — the
    /// KDF info already lives in account data the homeserver can see.
    #[wasm_bindgen(js_name = recoveryUsesPassphrase)]
    pub async fn recovery_uses_passphrase(&self) -> Result<bool, JsValue> {
        use matrix_sdk::ruma::events::GlobalAccountDataEventType;

        let secret_storage = self.client.encryption().secret_storage();
        let Some(default_key) = secret_storage
            .fetch_default_key_id()
            .await
            .map_err(|e| JsValue::from_str(&format!("{e}")))?
        else {
            return Ok(false); // no Secure Backup at all
        };
        let key_id = match default_key.deserialize() {
            Ok(content) => content.key_id,
            Err(_) => return Ok(false),
        };

        let event_type: GlobalAccountDataEventType =
            format!("m.secret_storage.key.{key_id}").as_str().into();
        let Some(raw) = self
            .client
            .account()
            .fetch_account_data(event_type)
            .await
            .map_err(|e| JsValue::from_str(&format!("{e}")))?
        else {
            return Ok(false);
        };
        // The key event carries a top-level `passphrase` object (KDF info) only
        // when it was created with one; presence is all we need. (The typed
        // `SecretStorageKeyEventContent` isn't plain-`Deserialize` — its event
        // type is keyed — so probe the raw field instead.)
        match raw.get_field::<serde_json::Value>("passphrase") {
            Ok(passphrase) => Ok(passphrase.is_some()),
            Err(_) => Ok(false),
        }
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
        // At-rest encryption (issue c72ec5df): passphrase derived from the master
        // secret (HKDF — see ui/src/lib/atRestCrypto.ts), supplied by the
        // unlock-first cold start so the encrypted IndexedDB store can be opened.
        // `None`/`undefined` keeps the legacy plaintext store for back-compat
        // during the hard-cutover migration.
        store_passphrase: Option<String>,
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
            .indexeddb_store(&store_name, store_passphrase.as_deref())
            .with_encryption_settings(default_encryption_settings())
            // Share Megolm keys only with devices cross-signed by their owner's
            // identity (not "all devices"): a device injected by a malicious
            // homeserver/MAS isn't signed by the user's identity, so it gets no
            // future keys — closing the future-read-via-bump reconstruction.
            // See the ADR 0001 addendum.
            .with_room_key_recipient_strategy(CollectStrategy::IdentityBasedStrategy)
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
        // At-rest encryption (issue c72ec5df): see `login`. None = plaintext.
        // For OAuth the secret isn't known until after recovery is set up, so
        // the encrypted store is established via the post-recovery re-key.
        store_passphrase: Option<String>,
    ) -> Result<String, JsValue> {
        let store_name = new_store_name("oauth");
        let client = Client::builder()
            .homeserver_url(&homeserver_url)
            .indexeddb_store(&store_name, store_passphrase.as_deref())
            .with_encryption_settings(default_encryption_settings())
            // Share Megolm keys only with devices cross-signed by their owner's
            // identity (not "all devices"): a device injected by a malicious
            // homeserver/MAS isn't signed by the user's identity, so it gets no
            // future keys — closing the future-read-via-bump reconstruction.
            // See the ADR 0001 addendum.
            .with_room_key_recipient_strategy(CollectStrategy::IdentityBasedStrategy)
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

/// Workspace roles as Matrix power levels. Deliberately the standard rungs:
/// 100 is the room creator's default, 0 is `events_default`, and anything below
/// `events_default` cannot send events at all — which is what makes a viewer
/// read-only at the server rather than only in our UI.
pub const ROLE_ADMIN_LEVEL: i64 = 100;
pub const ROLE_EDITOR_LEVEL: i64 = 0;
pub const ROLE_VIEWER_LEVEL: i64 = -1;

/// Bucket a raw power level into a role name. Levels between the rungs round
/// DOWN to the role whose privileges they actually have (a PL 50 moderator can
/// send events but not manage roles, so they read as an editor).
fn role_name(level: i64) -> &'static str {
    if level >= ROLE_ADMIN_LEVEL {
        "admin"
    } else if level >= ROLE_EDITOR_LEVEL {
        "editor"
    } else {
        "viewer"
    }
}

/// Flatten ruma's `UserPowerLevel` to a number. `Infinite` is the room-creator
/// case introduced in room version 12 — unambiguously an admin.
fn power_level_value(level: matrix_sdk::ruma::events::room::power_levels::UserPowerLevel) -> i64 {
    use matrix_sdk::ruma::events::room::power_levels::UserPowerLevel;
    match level {
        UserPowerLevel::Infinite => i64::MAX,
        UserPowerLevel::Int(i) => i.into(),
        // The enum is non_exhaustive; an unknown future variant is not evidence
        // of privilege, so treat it as the floor.
        _ => ROLE_VIEWER_LEVEL,
    }
}

fn power_level_for_role(role: &str) -> Option<i64> {
    match role {
        "admin" => Some(ROLE_ADMIN_LEVEL),
        "editor" => Some(ROLE_EDITOR_LEVEL),
        "viewer" => Some(ROLE_VIEWER_LEVEL),
        _ => None,
    }
}

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
    /// Highest Matrix `origin_server_ts` (ms) applied so far — gather + sync
    /// both advance it. Persisted in a snapshot as the resume point so the next
    /// cold start only fetches events newer than this marker.
    marker_ts: Rc<Cell<u64>>,
    /// Coalescing send queue: the latest pending `CellUpdate` per cell, keyed by
    /// (table, row, column). Rapid edits to the same cell (e.g. repeatedly
    /// dragging a kanban card) collapse to a single send, and a debounced
    /// background task drains this so write bursts don't trip the homeserver
    /// rate limit (`M_LIMIT_EXCEEDED`). Local state is applied immediately, so
    /// queueing the network send never delays the UI.
    pending: Rc<RefCell<HashMap<CellKey, CellUpdate>>>,
    /// Guard: whether a debounced flush task is currently scheduled/running.
    flushing: Rc<Cell<bool>>,
    /// Connection health (ADR 0003 phase 2): consecutive failed flush batches.
    /// Reset to 0 on any successful send.
    send_failures: Rc<Cell<u32>>,
    /// JS ms timestamp of the last successful batch send (session start until
    /// the first send).
    last_send_ok_ms: Rc<Cell<f64>>,
    /// JS ms timestamp of the last sync response received — proof the
    /// homeserver is reachable even when nothing is being sent.
    last_sync_ok_ms: Rc<Cell<f64>>,
    /// Cells whose writes were PERMANENTLY rejected and reverted (ADR 0003
    /// phase 3) — cumulative count, surfaced via connectionHealth().
    rejected_writes: Rc<Cell<u32>>,
    /// Human-readable reason for the most recent permanent rejection.
    last_reject_reason: Rc<RefCell<Option<String>>>,
    /// JS callback invoked whenever the pending queue changes, so the UI can
    /// mirror it to the persistent outbox AT THE MOMENT of the change — while
    /// the page is demonstrably alive — rather than at pagehide, where an
    /// async IndexedDB write can be aborted by the unload (issue 980ac596).
    queue_listener: Rc<RefCell<Option<js_sys::Function>>>,
}

#[wasm_bindgen]
impl ConnectedWorkspace {
    /// Create a connected workspace from a session and room ID.
    ///
    /// This is an async factory method that:
    /// 1. Verifies the room exists
    /// 2. Loads the persisted snapshot (if any) as a baseline
    /// 3. Paginates room history backwards, replaying cell-update events —
    ///    bounded to events newer than the snapshot marker when a usable
    ///    snapshot was provided (incremental cold start, issue 6f092cf4)
    ///
    /// `snapshot_json` is the last [`WorkspaceSnapshot`] persisted by
    /// [`snapshot`](Self::snapshot) for this room (the UI keeps it in
    /// IndexedDB), or `None`/invalid to force a full history gather.
    #[wasm_bindgen]
    pub async fn create(
        session: &MatrixSession,
        room_id: String,
        snapshot_json: Option<String>,
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

        // ── Load the persisted snapshot as a baseline (incremental cold start) ─
        // A usable snapshot (matching version, fully decryptable) lets us skip
        // re-paginating history older than its marker — that state is already
        // materialized here. A missing/old/incomplete snapshot leaves
        // `marker_ts = 0`, which degrades to today's full backward gather.
        let mut marker_ts: u64 = 0;
        let mut fast_path = false;
        if let Some(json) = snapshot_json {
            if let Ok(snap) = WorkspaceSnapshot::from_json(&json) {
                if snap.is_fast_path_usable() {
                    marker_ts = snap.marker_ts;
                    workspace.load_cells(snap.cells, snap.timestamp_counter);
                    fast_path = true;
                }
            }
        }

        // ── Fetch room history and replay events ──────────────────────
        // Workspace-level cold start (review §4.4): paginate backwards from the
        // end of the timeline and replay every cell-update event through
        // `Workspace::apply_update`, which routes user data, schema and view
        // updates to the right place. Values are LWW so order-independent;
        // per-cell history is bounded by order-based bumping at write time
        // (§4.3). With a snapshot we additionally stop early at the marker.
        // Immutable resume threshold for the incremental bound: everything
        // strictly older than the snapshot's marker is already materialized.
        // Kept separate from `marker_ts` (the running max we persist next) —
        // advancing the threshold inside the loop would raise it to the newest
        // event and skip every event between the marker and now (data loss on a
        // snapshot that lags the latest writes).
        let stop_before = marker_ts;
        let mut undecryptable_count = 0u32;
        let mut from_token: Option<String> = None;
        loop {
            let mut options = MessagesOptions::backward();
            if let Some(ref token) = from_token {
                options = options.from(token.as_str());
            }
            // Fetch large pages so cold start makes ~history/1000 round-trips
            // instead of ~history/10 (ruma's default limit). The homeserver caps
            // this to its own max and returns fewer if needed; the loop still
            // paginates the rest. Sharply cuts the network-round-trip component
            // of cold start.
            options.limit = matrix_sdk::ruma::UInt::from(1000u32);

            let response = room
                .messages(options)
                .await
                .map_err(|e| JsValue::from_str(&format!("Failed to fetch room history: {e}")))?;

            if response.chunk.is_empty() {
                break;
            }

            // Incremental bound (issue 48f042ba). /messages walks the server's
            // STREAM order, which — with Synapse workers / stream writers —
            // can disagree with origin_server_ts by persister skew. The old
            // rule ("break the whole walk at the FIRST event older than the
            // snapshot marker") assumed the two orders agree; one reordered
            // event then ended the walk early and every event deeper in the
            // stream was skipped — and because the running marker had already
            // advanced past them, no later incremental start would ever fetch
            // them: a permanent, self-sealing hole. (Exactly what shipped 8
            // missed events to prod on 2026-07-25; the single-process e2e
            // Synapse can't reproduce it because there the orders agree.)
            //
            // So: always process every event of a fetched page (LWW makes
            // re-applying pre-marker events idempotent), and stop paginating
            // only when the OLDEST event of the page is older than the marker
            // by more than a grace margin — a reordered event is lost only if
            // stream order and ots disagree by over the margin, far beyond
            // realistic worker skew.
            let mut page_oldest: Option<u64> = None;
            for timeline_event in &response.chunk {
                if let Ok(json_str) = serde_json::to_string(timeline_event.raw().json()) {
                    // An unparseable ts is treated as "newer" (fail-safe:
                    // process it, never skip).
                    let ots = MatrixClient::extract_origin_server_ts(&json_str);
                    if let Some(t) = ots {
                        page_oldest = Some(page_oldest.map_or(t, |m| m.min(t)));
                    }
                    // One timeline event may carry many cells (a batch event).
                    let received = MatrixClient::extract_cell_updates(&json_str);
                    if !received.is_empty() {
                        for r in received {
                            // Advance the snapshot marker from the cell event's
                            // envelope (same source as start_sync) so it never
                            // sits ahead of the cell state it represents.
                            let event_ts: u64 = r.origin_server_ts.0.into();
                            if event_ts > marker_ts {
                                marker_ts = event_ts;
                            }
                            // origin_server_ts is the LWW tiebreaker.
                            let _ = workspace.apply_update(r.into_update());
                        }
                    } else if MatrixClient::is_undecryptable_event(&json_str)
                        && (!fast_path || ots.is_none_or(|t| t >= stop_before))
                    {
                        // History we can't decrypt (no key) — count it so the UI
                        // can warn instead of silently materializing partial
                        // state. Pre-marker events are excluded on the fast
                        // path: the snapshot already accounts for them, and the
                        // grace-margin walk would otherwise recount them.
                        undecryptable_count += 1;
                    }
                }
            }

            if backfill_caught_up(fast_path, page_oldest, stop_before) {
                break;
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
            marker_ts: Rc::new(Cell::new(marker_ts)),
            pending: Rc::new(RefCell::new(HashMap::new())),
            flushing: Rc::new(Cell::new(false)),
            send_failures: Rc::new(Cell::new(0)),
            last_send_ok_ms: Rc::new(Cell::new(js_sys::Date::now())),
            last_sync_ok_ms: Rc::new(Cell::new(js_sys::Date::now())),
            rejected_writes: Rc::new(Cell::new(0)),
            last_reject_reason: Rc::new(RefCell::new(None)),
            queue_listener: Rc::new(RefCell::new(None)),
        })
    }

    /// Serialize the current materialized workspace state to a JSON
    /// [`WorkspaceSnapshot`] for the UI to persist locally. On the next cold
    /// start, passing it back to [`create`](Self::create) skips re-paginating
    /// history older than the marker.
    #[wasm_bindgen(js_name = snapshot)]
    pub fn snapshot(&self) -> String {
        let ws = self.inner.borrow();
        let snap = WorkspaceSnapshot {
            version: SNAPSHOT_VERSION,
            marker_ts: self.marker_ts.get(),
            timestamp_counter: ws.timestamp_counter(),
            undecryptable_count: self.undecryptable.get(),
            cells: ws.export_cells(),
        };
        snap.to_json().unwrap_or_default()
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
        let marker_ts = Rc::clone(&self.marker_ts);
        let last_sync_ok_ms = Rc::clone(&self.last_sync_ok_ms);

        spawn_local(async move {
            let settings = SyncSettings::default();

            let _ = client
                .sync_with_callback(settings, |response| {
                    let workspace = Rc::clone(&workspace);
                    let undecryptable = Rc::clone(&undecryptable);
                    let marker_ts = Rc::clone(&marker_ts);
                    let last_sync_ok_ms = Rc::clone(&last_sync_ok_ms);
                    let room_id = room_id.clone();
                    let on_change = on_change.clone();

                    async move {
                        // Every sync response is proof the homeserver answered
                        // (ADR 0003 phase 2 — connection health).
                        last_sync_ok_ms.set(js_sys::Date::now());
                        // Look for our room in the sync response
                        if let Some(joined) = response.rooms.joined.get(&room_id) {
                            let mut changed = false;

                            for raw_event in &joined.timeline.events {
                                // Try to extract our custom event(s) — one event
                                // may carry many cells (a batch event).
                                if let Ok(json_str) = serde_json::to_string(raw_event.raw().json())
                                {
                                    let received = MatrixClient::extract_cell_updates(&json_str);
                                    if !received.is_empty() {
                                        let mut ws = workspace.borrow_mut();
                                        for r in received {
                                            // Advance the snapshot marker from the
                                            // event envelope before consuming `r`.
                                            let ots: u64 = r.origin_server_ts.0.into();
                                            if ots > marker_ts.get() {
                                                marker_ts.set(ots);
                                            }
                                            // Attach origin_server_ts as the LWW tiebreaker.
                                            let _ = ws.apply_update(r.into_update());
                                        }
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

    /// The signed-in user's MXID — the viewer that `@me` filters resolve to.
    /// `None` only if the client somehow has no session.
    #[wasm_bindgen(js_name = currentUserId)]
    pub fn current_user_id(&self) -> Option<String> {
        self.client.user_id().map(|u| u.to_string())
    }

    /// The workspace roles, expressed as Matrix power levels — so they are
    /// enforced by the HOMESERVER, not merely hidden in our UI. That matters:
    /// the client is the trust boundary everywhere else in this app, but a
    /// power level is checked server-side on every event.
    ///
    /// - `admin`  (100) — manage members and roles; the room creator starts here
    /// - `editor` (0)   — the default; may send events, i.e. edit data
    /// - `viewer` (-1)  — below `events_default`, so the server REFUSES their
    ///                    writes. Read-only for real, not by convention.
    ///
    /// Cell updates are ordinary timeline events, so `events_default` is what
    /// gates editing the data.
    #[wasm_bindgen(js_name = roleForPowerLevel)]
    pub fn role_for_power_level(level: i64) -> String {
        role_name(level).to_string()
    }

    /// This user's role in the workspace (`admin` / `editor` / `viewer`).
    #[wasm_bindgen(js_name = myRole)]
    pub async fn my_role(&self) -> Result<String, JsValue> {
        let user_id = self
            .client
            .user_id()
            .ok_or_else(|| JsValue::from_str("Not signed in"))?
            .to_owned();
        let room = self
            .client
            .get_room(&self.room_id)
            .ok_or_else(|| JsValue::from_str("Room not found"))?;
        let level = room
            .get_user_power_level(&user_id)
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to read power level: {e}")))?;
        Ok(role_name(power_level_value(level)).to_string())
    }

    /// Set a member's role. Requires enough power to change power levels
    /// (admin); the homeserver rejects it otherwise, which is the point.
    #[wasm_bindgen(js_name = setUserRole)]
    pub async fn set_user_role(&self, user_id: String, role: String) -> Result<(), JsValue> {
        let user_id: OwnedUserId = user_id
            .as_str()
            .try_into()
            .map_err(|_| JsValue::from_str("Invalid user ID"))?;
        let level = power_level_for_role(&role)
            .ok_or_else(|| JsValue::from_str(&format!("Unknown role {role:?}")))?;
        let room = self
            .client
            .get_room(&self.room_id)
            .ok_or_else(|| JsValue::from_str("Room not found"))?;

        // Don't let the last admin demote themselves — the workspace would be
        // left with nobody able to manage members or roles, and no way back:
        // raising a power level requires a power level. Matrix itself permits
        // this, so the guard has to live here. Mirrors the same rule in
        // `leave_workspace`.
        if role != "admin" {
            let me = self
                .client
                .user_id()
                .ok_or_else(|| JsValue::from_str("Not signed in"))?;
            if user_id == me {
                let members = room
                    .members(RoomMemberships::ACTIVE)
                    .await
                    .map_err(|e| JsValue::from_str(&format!("Failed to list members: {e}")))?;
                let other_admins = members.iter().any(|m| {
                    m.user_id() != me && role_name(power_level_value(m.power_level())) == "admin"
                });
                if !other_admins {
                    return Err(JsValue::from_str(
                        "You're the only admin. Make someone else an admin first.",
                    ));
                }
            }
        }

        let level = matrix_sdk::ruma::Int::try_from(level)
            .map_err(|_| JsValue::from_str("Power level out of range"))?;
        room.update_power_levels(vec![(&user_id, level)])
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to set role: {e}")))?;
        Ok(())
    }

    /// Leave the workspace, and forget it so it disappears from this account.
    ///
    /// `remove_everyone` is the "delete" variant: kick every other member
    /// first, so the room is abandoned and unreachable. Note that Matrix has no
    /// delete-a-room operation — a room persists as long as any member remains
    /// — so this is as close as a client can get. On a homeserver configured
    /// with `forgotten_room_retention_period`, a room every local user has
    /// forgotten is purged from the database automatically; that config is what
    /// makes "forget" mean "eventually reclaimed" rather than "hidden".
    ///
    /// Refuses to strand a workspace: if you are its last admin and other
    /// members remain, appoint a successor first (`setUserRole`). Leaving as
    /// the LAST member is always allowed — there is nobody to strand, and the
    /// forget lets the server reclaim it.
    #[wasm_bindgen(js_name = leaveWorkspace)]
    pub async fn leave_workspace(&self, remove_everyone: bool) -> Result<(), JsValue> {
        let me = self
            .client
            .user_id()
            .ok_or_else(|| JsValue::from_str("Not signed in"))?
            .to_owned();
        let room = self
            .client
            .get_room(&self.room_id)
            .ok_or_else(|| JsValue::from_str("Room not found"))?;

        let members = room
            .members(RoomMemberships::ACTIVE)
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to list members: {e}")))?;
        let others: Vec<_> = members.iter().filter(|m| m.user_id() != me).collect();

        if remove_everyone {
            // The homeserver enforces this too; failing here just says why.
            let my_level = power_level_value(
                room.get_user_power_level(&me)
                    .await
                    .map_err(|e| JsValue::from_str(&format!("Failed to read power level: {e}")))?,
            );
            if role_name(my_level) != "admin" {
                return Err(JsValue::from_str(
                    "Only an admin can remove everyone from a workspace",
                ));
            }
            for m in &others {
                room.kick_user(m.user_id(), Some("Workspace deleted"))
                    .await
                    .map_err(|e| {
                        JsValue::from_str(&format!("Failed to remove {}: {e}", m.user_id()))
                    })?;
            }
        } else if !others.is_empty() {
            let my_level = power_level_value(
                room.get_user_power_level(&me)
                    .await
                    .map_err(|e| JsValue::from_str(&format!("Failed to read power level: {e}")))?,
            );
            if role_name(my_level) == "admin" {
                let another_admin = others
                    .iter()
                    .any(|m| role_name(power_level_value(m.power_level())) == "admin");
                if !another_admin {
                    return Err(JsValue::from_str(
                        "You are the only admin. Make someone else an admin before leaving,                          or remove everyone and delete the workspace.",
                    ));
                }
            }
        }

        room.leave()
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to leave workspace: {e}")))?;
        // Forget is what lets the server reclaim the room once everyone has
        // gone; it only works on an already-left room, hence the order.
        room.forget()
            .await
            .map_err(|e| JsValue::from_str(&format!("Left, but failed to forget: {e}")))?;
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
                    "role": role_name(power_level_value(m.power_level())),
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
            ws.create_table(definition).map_err(|e| match e {
                crate::Error::TableAlreadyExists => {
                    JsValue::from_str("A table with that name already exists")
                }
                _ => JsValue::from_str("Failed to create table"),
            })?
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

    /// Connection health snapshot (ADR 0003 phase 2), as JSON:
    /// `{pendingCount, consecutiveSendFailures, msSinceLastSendOk,
    /// msSinceLastSyncOk}`. The POLICY (when to call the connection "down" and
    /// lock writes) lives in the UI — this is just the raw signal. Sync
    /// responses count as proof of reachability even when nothing is sending.
    #[wasm_bindgen(js_name = connectionHealth)]
    pub fn connection_health(&self) -> String {
        let now = js_sys::Date::now();
        format!(
            r#"{{"pendingCount":{},"consecutiveSendFailures":{},"msSinceLastSendOk":{},"msSinceLastSyncOk":{}}}"#,
            self.pending.borrow().len(),
            self.send_failures.get(),
            (now - self.last_send_ok_ms.get()).max(0.0) as u64,
            (now - self.last_sync_ok_ms.get()).max(0.0) as u64,
        )
    }

    /// Cumulative permanently-rejected (dropped + reverted) writes and the
    /// most recent reason, for the send-failure banner (ADR 0003 phase 3).
    #[wasm_bindgen(js_name = rejectedWrites)]
    pub fn rejected_writes_info(&self) -> String {
        let reason = self.last_reject_reason.borrow().clone().unwrap_or_default();
        format!(
            r#"{{"count":{},"lastReason":{}}}"#,
            self.rejected_writes.get(),
            serde_json::to_string(&reason).unwrap_or_else(|_| "\"\"".to_string()),
        )
    }

    // ── Persistent outbox (ADR 0003 phase 1) ────────────────────────────────

    /// The current pending (unsent) cell updates as a JSON array — the
    /// in-memory send queue, for the UI to mirror to the encrypted outbox
    /// store. Empty array = nothing unsent.
    #[wasm_bindgen(js_name = pendingUpdates)]
    pub fn pending_updates(&self) -> Result<String, JsValue> {
        let pending = self.pending.borrow();
        let updates: Vec<&CellUpdate> = pending.values().collect();
        serde_json::to_string(&updates).map_err(|_| JsValue::from_str("Serialization failed"))
    }

    /// Replay a persisted outbox (the JSON from [`pendingUpdates`]) after a
    /// cold start: each update re-applies to the local workspace under LWW —
    /// a write another client has since superseded loses fairly, because it
    /// carries its original HLC timestamp — and re-enters the send queue.
    /// Call once, after `create()`, before user edits.
    #[wasm_bindgen(js_name = restorePendingUpdates)]
    pub fn restore_pending_updates(&self, json: &str) -> Result<u32, JsValue> {
        let updates: Vec<CellUpdate> =
            serde_json::from_str(json).map_err(|_| JsValue::from_str("Invalid outbox JSON"))?;
        if updates.is_empty() {
            return Ok(0);
        }
        let count = updates.len() as u32;
        {
            let mut ws = self.inner.borrow_mut();
            for update in &updates {
                // Best-effort: an update for a since-deleted table just no-ops.
                let _ = ws.apply_update(update.clone());
            }
        }
        self.enqueue_updates(updates);
        Ok(count)
    }

    /// The change history for the History drawer: every real cell edit (order-
    /// based compaction bumps are filtered out) plus every recorded revert, as a
    /// JSON array sorted newest-first. Pass a `table_id` to scope it to one table
    /// or `None` for the whole workspace. Edits are
    /// `{kind:"edit", tableId, rowId, columnId, value, prevValue, sender,
    /// serverTs}`; reverts are `{kind:"revert", id, actor, target, scope, label,
    /// serverTs}`.
    #[wasm_bindgen(js_name = getChangeLog)]
    pub async fn get_change_log(&self, table_id: Option<String>) -> Result<String, JsValue> {
        let fetched = self.fetch_cell_events().await?;

        // Each revert is a row in the `_history` table; capture its newest
        // server_ts so the drawer entry sorts among the edits correctly.
        let mut revert_ts: HashMap<String, u64> = HashMap::new();
        for (_, u) in &fetched {
            if u.table_id == crate::history::HISTORY_TABLE_ID {
                let ts = u.server_timestamp.unwrap_or(0);
                let slot = revert_ts.entry(u.row_id.clone()).or_insert(0);
                *slot = (*slot).max(ts);
            }
        }

        // Edits: sort oldest-first, walk per cell to attach prevValue and drop
        // no-op compaction bumps (value unchanged from the prior write).
        let mut edits: Vec<&(String, CellUpdate)> = fetched
            .iter()
            .filter(|(_, u)| u.table_id != crate::history::HISTORY_TABLE_ID)
            .filter(|(_, u)| table_id.as_deref().is_none_or(|t| u.table_id == t))
            .collect();
        edits.sort_by_key(|(_, u)| (u.server_timestamp.unwrap_or(0), u.timestamp));

        let mut last: HashMap<(String, String, String), serde_json::Value> = HashMap::new();
        let mut entries: Vec<serde_json::Value> = Vec::new();
        for (sender, u) in edits {
            let key = (u.table_id.clone(), u.row_id.clone(), u.column_id.clone());
            let prev = last.get(&key).cloned();
            let is_bump = prev.as_ref() == Some(&u.value);
            if !is_bump {
                entries.push(serde_json::json!({
                    "kind": "edit",
                    "tableId": u.table_id,
                    "rowId": u.row_id,
                    "columnId": u.column_id,
                    "value": u.value,
                    "prevValue": prev,
                    "sender": sender,
                    "serverTs": u.server_timestamp.unwrap_or(0),
                }));
            }
            last.insert(key, u.value.clone());
        }

        // Reverts (the "rollback messages").
        for rec in self.inner.borrow().history_reverts() {
            let in_scope = table_id
                .as_deref()
                .is_none_or(|t| rec.scope == t || rec.scope == "*");
            if !in_scope {
                continue;
            }
            entries.push(serde_json::json!({
                "kind": "revert",
                "id": rec.id,
                "actor": rec.actor,
                "target": rec.target,
                "scope": rec.scope,
                "label": rec.label,
                "serverTs": revert_ts.get(&rec.id).copied().unwrap_or(0),
            }));
        }

        // Newest first.
        entries.sort_by(|a, b| {
            let ts =
                |v: &serde_json::Value| v.get("serverTs").and_then(|t| t.as_u64()).unwrap_or(0);
            ts(b).cmp(&ts(a))
        });

        serde_json::to_string(&entries).map_err(|e| JsValue::from_str(&format!("{e}")))
    }

    /// Roll `table_id` back to its state at `target_server_ts` (a Matrix
    /// `origin_server_ts`, ms). Fetches the timeline, computes the batched
    /// restoring updates + a `_history` revert row, sends them, and returns the
    /// number of updates sent (0 = the table already matched that point — nothing
    /// was recorded or sent).
    #[wasm_bindgen(js_name = rollbackTo)]
    pub async fn rollback_to(
        &self,
        table_id: String,
        target_server_ts: f64,
        label: Option<String>,
    ) -> Result<u32, JsValue> {
        let events: Vec<CellUpdate> = self
            .fetch_cell_events()
            .await?
            .into_iter()
            .map(|(_, u)| u)
            .collect();
        let target = target_server_ts.max(0.0) as u64;
        let actor = self
            .client
            .user_id()
            .map(|u| u.to_string())
            .unwrap_or_default();
        let revert = crate::history::RevertRecord {
            id: format!("rev-{}-{}", target, js_sys::Date::now() as u64),
            actor,
            target,
            scope: table_id.clone(),
            label,
        };

        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.build_rollback(&events, target, Some(&table_id), revert)
        };
        if updates.is_empty() {
            return Ok(0);
        }
        self.send_updates(&updates).await?;
        Ok(updates.len() as u32)
    }

    /// Paginate the whole room timeline and collect every cell update (data and
    /// system tables), each tagged with `(sender, update-with-server_ts)`. Shared
    /// by the change log and rollback; walks full history, so it runs on demand
    /// (drawer open / revert), never on the write hot path.
    async fn fetch_cell_events(&self) -> Result<Vec<(String, CellUpdate)>, JsValue> {
        fetch_room_cell_updates(&self.client, &self.room_id).await
    }
}

/// Free-function timeline walk (shared by the change log, rollback, and the
/// permanent-rejection revert in `flush_pending`, which has no `&self`).
async fn fetch_room_cell_updates(
    client: &Client,
    room_id: &OwnedRoomId,
) -> Result<Vec<(String, CellUpdate)>, JsValue> {
    {
        let room = client
            .get_room(room_id)
            .ok_or_else(|| JsValue::from_str("Room not found"))?;
        let mut out: Vec<(String, CellUpdate)> = Vec::new();
        let mut from_token: Option<String> = None;
        loop {
            let mut options = MessagesOptions::backward();
            if let Some(ref token) = from_token {
                options = options.from(token.as_str());
            }
            options.limit = matrix_sdk::ruma::UInt::from(1000u32);
            let response = room
                .messages(options)
                .await
                .map_err(|e| JsValue::from_str(&format!("Failed to fetch room history: {e}")))?;
            if response.chunk.is_empty() {
                break;
            }
            for event in &response.chunk {
                let Ok(json_str) = serde_json::to_string(event.raw().json()) else {
                    continue;
                };
                let received = MatrixClient::extract_cell_updates(&json_str);
                if received.is_empty() {
                    continue;
                }
                let sender = serde_json::from_str::<serde_json::Value>(&json_str)
                    .ok()
                    .and_then(|v| v.get("sender").and_then(|s| s.as_str()).map(String::from))
                    .unwrap_or_default();
                for r in received {
                    out.push((sender.clone(), r.into_update()));
                }
            }
            match response.end {
                Some(token) => from_token = Some(token),
                None => break,
            }
        }
        Ok(out)
    }
}

#[wasm_bindgen]
impl ConnectedWorkspace {
    /// Delete a row from a table.
    ///
    /// Writes a row-level tombstone cell (`_deleted = true`) locally and syncs
    /// it to Matrix so the deletion is durable (survives reload) and propagates
    /// to other devices. Unlike rapid cell edits, a delete is a discrete action,
    /// so it is sent immediately (awaited) rather than through the coalescing
    /// queue — matching `delete_column` and giving the UI a real success/failure
    /// to surface. See [`crate::workspace::Workspace::delete_row`].
    #[wasm_bindgen(js_name = deleteRow)]
    pub async fn delete_row(&self, table_id: String, row_id: String) -> Result<(), JsValue> {
        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.delete_row(&table_id, &row_id)
                .map_err(|e| JsValue::from_str(&format!("{e}")))?
        };

        self.send_updates(&updates).await?;

        Ok(())
    }

    /// Delete a table. Writes a `deleted` tombstone (+ `deleted_at` cutoff) on
    /// the `_tables` registry row and syncs it, like `deleteRow`/`deleteColumn`:
    /// durable, propagates to other devices, and hides the table everywhere.
    #[wasm_bindgen(js_name = deleteTable)]
    pub async fn delete_table(&self, table_id: String) -> Result<(), JsValue> {
        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.delete_table(&table_id)
                .map_err(|e| JsValue::from_str(&format!("{e}")))?
        };
        self.send_updates(&updates).await?;
        Ok(())
    }

    /// Persist a column's display width. Column metadata, not a view setting,
    /// so a resize reaches collaborators and applies on the raw table too.
    #[wasm_bindgen(js_name = setColumnWidth)]
    pub async fn set_column_width(
        &self,
        table_id: String,
        column_id: String,
        width: f64,
    ) -> Result<(), JsValue> {
        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.update_column(
                &table_id,
                &column_id,
                &serde_json::json!({ "width": width }),
            )
            .map_err(|e| JsValue::from_str(&format!("{e}")))?
        };
        self.send_updates(&updates).await?;
        Ok(())
    }

    /// Rename a table in place — one LWW write to its `_tables` name cell, so
    /// columns, rows, and views all survive untouched.
    #[wasm_bindgen(js_name = renameTable)]
    pub async fn rename_table(&self, table_id: String, name: String) -> Result<(), JsValue> {
        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.rename_table(&table_id, &name)
                .map_err(|e| JsValue::from_str(&format!("{e}")))?
        };
        self.send_updates(&updates).await?;
        Ok(())
    }

    /// Delete a saved view (decay-model tombstone), like deleteTable. The
    /// table and its data are untouched — a view is only a projection.
    #[wasm_bindgen(js_name = deleteView)]
    pub async fn delete_view(&self, view_id: String) -> Result<(), JsValue> {
        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.delete_view(&view_id)
                .map_err(|e| JsValue::from_str(&format!("{e}")))?
        };
        self.send_updates(&updates).await?;
        Ok(())
    }

    /// Set a table's manual-ordering key (fractional index) and sync it. The UI
    /// computes the key (same `fractionalIndex.ts` as row reorder) and calls
    /// this per moved table.
    #[wasm_bindgen(js_name = setTableOrder)]
    pub async fn set_table_order(
        &self,
        table_id: String,
        order_key: String,
    ) -> Result<(), JsValue> {
        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.set_table_order(&table_id, &order_key)
                .map_err(|e| JsValue::from_str(&format!("{e}")))?
        };
        self.send_updates(&updates).await?;
        Ok(())
    }

    /// Export one table as a standalone CSV (ADR 0004): headers are column
    /// names and references render as labels, so the file opens as an ordinary
    /// spreadsheet rather than a page of row ids.
    #[wasm_bindgen(js_name = exportTableCsv)]
    pub fn export_table_csv(&self, table_id: String) -> Result<String, JsValue> {
        let ws = self.inner.borrow();
        crate::archive::table_to_csv(&ws, &table_id)
            .ok_or_else(|| JsValue::from_str("Table not found"))
    }

    /// Export the whole workspace as an archive: a JSON object of
    /// `relative path -> file contents`. Use [`Self::export_workspace_zip`]
    /// for the one-file form; this is for callers that want the parts.
    #[wasm_bindgen(js_name = exportWorkspaceArchive)]
    pub fn export_workspace_archive(&self, name: String) -> String {
        let ws = self.inner.borrow();
        let files = crate::archive::Archive::from_workspace(&ws, name).to_files();
        serde_json::to_string(&files).unwrap_or_else(|_| "{}".to_string())
    }

    /// Export the whole workspace as a zip (ADR 0004) — the one file you hand
    /// to someone. Same container the CLI writes and reads.
    #[wasm_bindgen(js_name = exportWorkspaceZip)]
    pub fn export_workspace_zip(&self, name: String) -> Result<Vec<u8>, JsValue> {
        let ws = self.inner.borrow();
        crate::archive::Archive::from_workspace(&ws, name)
            .to_zip()
            .map_err(|e| JsValue::from_str(&format!("{e}")))
    }

    /// Read an archive's metadata without applying it — `{name, description,
    /// tables:[{id,name,rows}], views}`. This is what a template gallery
    /// renders: the blurb lives in the archive, not in app code beside it.
    #[wasm_bindgen(js_name = describeArchive)]
    pub fn describe_archive(files_json: &str) -> Result<String, JsValue> {
        let files: crate::archive::Files = serde_json::from_str(files_json)
            .map_err(|_| JsValue::from_str("Invalid archive files"))?;
        let archive = crate::archive::Archive::from_files(&files)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;
        Ok(serde_json::json!({
            "name": archive.name,
            "description": archive.description,
            "views": archive.views.len(),
            "tables": archive.tables.iter().map(|t| serde_json::json!({
                "id": t.id,
                "name": t.name,
                "rows": t.rows.len(),
            })).collect::<Vec<_>>(),
        })
        .to_string())
    }

    /// Apply an archive given as a JSON map of `path -> contents` — the form
    /// shipped templates take, since a directory of CSVs is reviewable in a
    /// PR in a way a zip is not.
    #[wasm_bindgen(js_name = importWorkspaceArchive)]
    pub async fn import_workspace_archive(&self, files_json: String) -> Result<String, JsValue> {
        let files: crate::archive::Files = serde_json::from_str(&files_json)
            .map_err(|_| JsValue::from_str("Invalid archive files"))?;
        let archive = crate::archive::Archive::from_files(&files)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;
        Ok(self.apply_archive(archive))
    }

    /// Import a workspace archive (zip) into this workspace. Existing tables
    /// are appended to rather than replaced — see
    /// [`crate::archive::Archive::apply_to_workspace`].
    ///
    /// Returns `{rowsWritten, issues}`, like `importCsv`.
    #[wasm_bindgen(js_name = importWorkspaceZip)]
    pub async fn import_workspace_zip(&self, bytes: Vec<u8>) -> Result<String, JsValue> {
        let archive = crate::archive::Archive::from_zip(&bytes)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;
        Ok(self.apply_archive(archive))
    }

    /// Shared tail of every archive import: apply, enqueue the writes, and
    /// report. Enqueued rather than sent inline for the same reason `importCsv`
    /// is — a template with a few hundred cells would otherwise be a few
    /// hundred requests.
    fn apply_archive(&self, archive: crate::archive::Archive) -> String {
        let stamp = js_sys::Date::now() as u64;
        let result = {
            let mut ws = self.inner.borrow_mut();
            archive.apply_to_workspace(&mut ws, &mut |table, row| {
                format!("row_{stamp}_{table}_{row}")
            })
        };
        self.enqueue_updates(result.updates);
        serde_json::json!({
            "rowsWritten": result.rows_written,
            "issues": result.issues.iter().map(|i| serde_json::json!({
                "table": i.table,
                "row": i.row,
                "column": i.column,
                "message": i.message,
            })).collect::<Vec<_>>(),
        })
        .to_string()
    }

    /// Inspect a CSV without importing it — the data behind the preview step.
    /// Returns `{columns:[{id,name,type,options,existing}], rows, totalRows,
    /// issues}`, where `rows` is capped at `sample` records and `issues` is the
    /// full dry-run result so the user sees the failure count before
    /// committing, not after.
    ///
    /// When `table_id` names a table that already exists, its live columns win
    /// on type and are flagged `existing`, so the preview shows what will
    /// actually happen rather than what the CSV alone suggests.
    ///
    /// `overrides_json` is the column list as the user has edited it so far
    /// (empty on first open) — re-previewing after a type change re-validates
    /// against the new types.
    #[wasm_bindgen(js_name = previewCsvImport)]
    pub fn preview_csv_import(
        &self,
        table_id: String,
        csv: &str,
        sample: usize,
        overrides_json: &str,
    ) -> String {
        let table = crate::archive::table_from_csv(&table_id, &table_id, csv);
        let ws = self.inner.borrow();
        let existing = ws.get_table_schema(&table_id);
        let overrides: Vec<crate::schema::ColumnDefinition> =
            serde_json::from_str(overrides_json).unwrap_or_default();

        // Precedence, weakest first: inferred from the CSV, the live column if
        // the destination already has one by that name, then the user's own
        // choice — which always wins, because inference is a starting point.
        let effective: Vec<crate::schema::ColumnDefinition> = table
            .columns
            .iter()
            .map(|c| {
                let live = existing
                    .as_ref()
                    .and_then(|s| s.columns.values().find(|e| e.name == c.name));
                let chosen = overrides.iter().find(|o| o.name == c.name);
                chosen.or(live).unwrap_or(c).clone()
            })
            .collect();

        let columns: Vec<serde_json::Value> = table
            .columns
            .iter()
            .zip(&effective)
            .map(|(c, e)| {
                serde_json::json!({
                    "id": e.id,
                    "name": c.name,
                    "type": crate::archive::column_type_name(&e.column_type),
                    "options": e.options,
                    "existing": existing
                        .as_ref()
                        .is_some_and(|s| s.columns.values().any(|x| x.name == c.name)),
                })
            })
            .collect();

        let header: Vec<&String> = table.columns.iter().map(|c| &c.name).collect();
        let rows: Vec<Vec<String>> = table
            .rows
            .iter()
            .take(sample)
            .map(|r| {
                header
                    .iter()
                    .map(|h| r.get(*h).cloned().unwrap_or_default())
                    .collect()
            })
            .collect();

        let issues = crate::archive::validate_table(&ws, &table, &effective);

        serde_json::json!({
            "columns": columns,
            "rows": rows,
            "totalRows": table.rows.len(),
            "issues": issues.iter().map(|i| serde_json::json!({
                "row": i.row,
                "column": i.column,
                "message": i.message,
            })).collect::<Vec<_>>(),
        })
        .to_string()
    }

    /// Import a CSV into `table_id`, creating it as `table_name` if absent and
    /// appending to it if not. `columns_json` is the preview's column list
    /// after any user overrides — the types the user actually confirmed.
    ///
    /// Returns `{rowsWritten, issues:[{row,column,message}]}`. Writes go
    /// through the durable queue, like every other write.
    #[wasm_bindgen(js_name = importCsv)]
    pub async fn import_csv(
        &self,
        table_id: String,
        table_name: String,
        csv: String,
        columns_json: String,
    ) -> Result<String, JsValue> {
        let mut table = crate::archive::table_from_csv(&table_id, &table_name, &csv);

        // Apply the confirmed column list, matched to the CSV's headers by
        // name. Anything the user didn't mention keeps its inferred type.
        let confirmed: Vec<crate::schema::ColumnDefinition> =
            serde_json::from_str(&columns_json).unwrap_or_default();
        for c in confirmed {
            if let Some(target) = table.columns.iter_mut().find(|t| t.name == c.name) {
                *target = c;
            }
        }

        let stamp = js_sys::Date::now() as u64;
        let result = {
            let mut ws = self.inner.borrow_mut();
            crate::archive::Archive {
                name: table_name,
                description: String::new(),
                tables: vec![table],
                views: Vec::new(),
            }
            .apply_to_workspace(&mut ws, &mut |_, row| format!("row_{stamp}_{row}"))
        };

        // Enqueue rather than send inline: a large import would otherwise fire
        // one request per cell and trip the homeserver rate limit. The flush
        // task coalesces and paces them, and the encrypted outbox makes the
        // import durable across a reload before it lands.
        self.enqueue_updates(result.updates);

        Ok(serde_json::json!({
            "rowsWritten": result.rows_written,
            "issues": result.issues.iter().map(|i| serde_json::json!({
                "row": i.row,
                "column": i.column,
                "message": i.message,
            })).collect::<Vec<_>>(),
        })
        .to_string())
    }

    /// Map of `table_id -> manual-ordering key` as a JSON object, for the UI's
    /// drag-to-reorder of the table list.
    #[wasm_bindgen(js_name = getTableOrderKeys)]
    pub fn get_table_order_keys(&self) -> String {
        let ws = self.inner.borrow();
        let map: std::collections::HashMap<String, String> =
            ws.get_table_order_keys().into_iter().collect();
        serde_json::to_string(&map).unwrap_or_else(|_| "{}".to_string())
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

    /// Map of `row_id -> manual-ordering key` as a JSON object, for the UI's
    /// drag-to-reorder.
    #[wasm_bindgen(js_name = getRowOrderKeys)]
    pub fn get_row_order_keys(&self, table_id: String) -> Result<String, JsValue> {
        let ws = self.inner.borrow();
        let keys = ws
            .get_row_order_keys(&table_id)
            .map_err(|_| JsValue::from_str("Table not found"))?;
        let map: std::collections::HashMap<String, String> = keys.into_iter().collect();
        serde_json::to_string(&map).map_err(|_| JsValue::from_str("Serialization failed"))
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

    /// Update mutable fields of a column (rename / retype / options / default).
    /// `patch_json` is a JSON object with any of `name`/`column_type`/`options`/
    /// `default_value`.
    #[wasm_bindgen(js_name = updateColumn)]
    pub async fn update_column(
        &self,
        table_id: String,
        column_id: String,
        patch_json: &str,
    ) -> Result<(), JsValue> {
        let patch: serde_json::Value = serde_json::from_str(patch_json)
            .map_err(|_| JsValue::from_str("Invalid column patch"))?;

        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.update_column(&table_id, &column_id, &patch)
                .map_err(|_| JsValue::from_str("Failed to update column"))?
        };

        self.send_updates(&updates).await?;

        Ok(())
    }

    /// Delete a column (decay model — marks it deleted in the schema).
    #[wasm_bindgen(js_name = deleteColumn)]
    pub async fn delete_column(&self, table_id: String, column_id: String) -> Result<(), JsValue> {
        let updates = {
            let mut ws = self.inner.borrow_mut();
            ws.delete_column(&table_id, &column_id)
                .map_err(|_| JsValue::from_str("Failed to delete column"))?
        };

        self.send_updates(&updates).await?;

        Ok(())
    }

    /// Register a callback invoked whenever the pending send queue changes.
    /// The UI uses this to mirror the queue into the encrypted outbox at the
    /// moment of the change, while the page is alive — a pagehide-time
    /// IndexedDB write can be aborted by the unload and silently lose the
    /// mirror (issue 980ac596). Replaces any previously registered callback.
    #[wasm_bindgen(js_name = onQueueChanged)]
    pub fn on_queue_changed(&self, callback: js_sys::Function) {
        *self.queue_listener.borrow_mut() = Some(callback);
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
        notify_queue_changed(&self.queue_listener);
        self.schedule_flush();
    }

    /// Start the debounced background flush task, unless one is already running.
    ///
    /// WASM is single-threaded and cooperative, so there is no interleaving
    /// between this guard check and the task's `flushing.set(false)` on exit:
    /// any [`enqueue_updates`](Self::enqueue_updates) after the task ends sees
    /// `flushing == false` and schedules a fresh task.
    fn schedule_flush(&self) {
        self.schedule_flush_with_delay(300);
    }

    /// As [`schedule_flush`](Self::schedule_flush), with an explicit first
    /// delay — 0 for discrete operations, the debounce for coalescing edits.
    fn schedule_flush_with_delay(&self, first_delay_ms: u64) {
        if self.flushing.get() {
            return;
        }
        self.flushing.set(true);

        let client = self.client.clone();
        let room_id = self.room_id.clone();
        let pending = Rc::clone(&self.pending);
        let flushing = Rc::clone(&self.flushing);
        let send_failures = Rc::clone(&self.send_failures);
        let last_send_ok_ms = Rc::clone(&self.last_send_ok_ms);
        let inner = Rc::clone(&self.inner);
        let rejected_writes = Rc::clone(&self.rejected_writes);
        let last_reject_reason = Rc::clone(&self.last_reject_reason);
        let queue_listener = Rc::clone(&self.queue_listener);

        spawn_local(async move {
            flush_pending(
                client,
                room_id,
                pending,
                flushing,
                send_failures,
                last_send_ok_ms,
                inner,
                rejected_writes,
                last_reject_reason,
                queue_listener,
                first_delay_ms,
            )
            .await;
        });
    }

    /// Send a batch of CellUpdates to the Matrix room.
    /// Route a discrete operation's updates into the SAME durable pipeline as
    /// cell edits (issue 980ac596). Previously these were sent directly with
    /// their own retry loop — applied locally, shown by any sync-triggered
    /// refresh, but with NO durability between local apply and server ack. A
    /// reload in that window silently discarded the operation (a server-acked
    /// rename could still be shown from local state before its send finished).
    ///
    /// Enqueued updates are covered by `pendingUpdates()` → the encrypted
    /// outbox mirror → `restorePendingUpdates()` on the next cold start, and
    /// inherit the queue's rate-limit backoff and permanent-rejection
    /// classification (ADR 0003). One delivery path, one durability guarantee,
    /// for data and metadata alike.
    ///
    /// The fail-closed encryption guard stays HERE as well as in `send_batch`:
    /// erroring at the call site tells the user their operation won't sync,
    /// instead of quietly parking it in a queue that can never drain.
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

        if updates.is_empty() {
            return Ok(());
        }

        // Discrete ops flush immediately (no debounce): they are one-shot user
        // actions, not keystroke bursts, and the sooner the send starts the
        // smaller the window in which only the outbox protects them.
        let my_cells: Vec<(CellKey, u64)> = updates
            .iter()
            .map(|u| {
                (
                    (u.table_id.clone(), u.row_id.clone(), u.column_id.clone()),
                    u.timestamp,
                )
            })
            .collect();
        {
            let mut pending = self.pending.borrow_mut();
            for update in updates {
                merge_pending(&mut pending, update.clone());
            }
        }
        notify_queue_changed(&self.queue_listener);
        self.schedule_flush_with_delay(0);

        // Belt AND suspenders: the queue+outbox make the operation durable
        // against a crash or an ill-timed reload, but callers still deserve
        // "resolved ⇒ off this device" — the UI shows the result on resolve,
        // and an instantly-resolving rename invites the user to close the tab
        // ahead of the send. So wait (bounded) until our cells have left the
        // queue: sent, superseded by a newer write, or dropped as permanently
        // rejected (surfaced via rejectedWrites, like any cell edit). On
        // timeout resolve anyway — durability is the outbox's job from there.
        for _ in 0..200u32 {
            let still_queued = {
                let p = self.pending.borrow();
                my_cells
                    .iter()
                    .any(|(k, ts)| p.get(k).is_some_and(|cur| cur.timestamp == *ts))
            };
            if !still_queued {
                break;
            }
            matrix_sdk::sleep::sleep(Duration::from_millis(50)).await;
        }
        Ok(())
    }
}

/// Insert `update` into the coalescing queue, keeping the entry with the highest
/// timestamp per cell. Values are last-writer-wins, so only the latest write to
/// a cell needs to reach the server — superseded intermediate writes (and stale
/// compaction bumps) are dropped.
/// Invoke the queue-change listener, if one is registered. The Function is
/// cloned out of the RefCell before the call so the callback may re-register
/// (or read `pendingUpdates()`) without hitting a live borrow.
fn notify_queue_changed(listener: &Rc<RefCell<Option<js_sys::Function>>>) {
    let cb = listener.borrow().clone();
    if let Some(cb) = cb {
        let _ = cb.call0(&JsValue::NULL);
    }
}

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
    send_failures: Rc<Cell<u32>>,
    last_send_ok_ms: Rc<Cell<f64>>,
    inner: Rc<RefCell<Workspace>>,
    rejected_writes: Rc<Cell<u32>>,
    last_reject_reason: Rc<RefCell<Option<String>>>,
    queue_listener: Rc<RefCell<Option<js_sys::Function>>>,
    first_delay_ms: u64,
) {
    const DEBOUNCE_MS: u64 = 300;
    const MAX_BACKOFF_MS: u64 = 8_000;
    let mut backoff_ms = first_delay_ms;

    loop {
        matrix_sdk::sleep::sleep(Duration::from_millis(backoff_ms)).await;

        // Snapshot WITHOUT draining (issue 980ac596): while the send is in
        // flight the entries stay in `pending`, so `pendingUpdates()` — and
        // therefore the outbox mirror — still covers them. Draining first
        // opened a window where a reload mid-send lost the batch: gone from
        // the queue, never reached the server. Entries are removed only on
        // confirmed outcomes below.
        let batch: Vec<CellUpdate> = {
            let p = pending.borrow();
            p.values().cloned().collect()
        };

        if batch.is_empty() {
            flushing.set(false);
            return;
        }

        match send_batch(&client, &room_id, batch.clone()).await {
            SendOutcome::Sent => {
                // Remove exactly what was sent — an edit that arrived during
                // the flight has a higher timestamp and must survive for the
                // next pass.
                let mut p = pending.borrow_mut();
                for u in &batch {
                    let key = (u.table_id.clone(), u.row_id.clone(), u.column_id.clone());
                    if p.get(&key).is_some_and(|cur| cur.timestamp <= u.timestamp) {
                        p.remove(&key);
                    }
                }
                notify_queue_changed(&queue_listener);
                backoff_ms = DEBOUNCE_MS;
                send_failures.set(0);
                last_send_ok_ms.set(js_sys::Date::now());
            }
            SendOutcome::Retryable(_) => {
                // Still in `pending` (nothing was drained) — just back off.
                // Floor at the debounce: an immediate-flush task starts from 0,
                // and 0 × 2 = 0 would spin hot against a rate limit.
                send_failures.set(send_failures.get().saturating_add(1));
                backoff_ms = backoff_ms
                    .max(DEBOUNCE_MS)
                    .saturating_mul(2)
                    .min(MAX_BACKOFF_MS);
            }
            SendOutcome::Rejected { updates, reason } => {
                // Permanent (ADR 0003 phase 3): retrying can never succeed, so
                // drop the batch and roll the affected cells back to converged
                // state — the writes never left this device, so a LOCAL apply
                // (never enqueued) makes this client match every other one.
                // If the timeline fetch fails we still drop and surface: a
                // dirty cell is recoverable via the next sync/reload; an
                // infinite retry loop is not.
                let ids: Vec<tables_over_matrix::CellId> = updates
                    .iter()
                    .map(|u| tables_over_matrix::CellId::new(&u.table_id, &u.row_id, &u.column_id))
                    .collect();
                if let Ok(fetched) = fetch_room_cell_updates(&client, &room_id).await {
                    let events: Vec<CellUpdate> = fetched.into_iter().map(|(_, u)| u).collect();
                    let converged = crate::history::converged_values(&ids, &events);
                    let mut ws = inner.borrow_mut();
                    for (id, value) in converged {
                        let ts = ws.next_timestamp_pub();
                        let _ = ws.apply_update(CellUpdate::new(
                            id.table_id.clone(),
                            id.row_id.clone(),
                            id.column_id.clone(),
                            value,
                            ts,
                        ));
                    }
                }
                {
                    // Drop the rejected writes from the queue — retrying can
                    // never succeed, and leaving them would wedge the flush.
                    let mut p = pending.borrow_mut();
                    for u in &updates {
                        let key = (u.table_id.clone(), u.row_id.clone(), u.column_id.clone());
                        if p.get(&key).is_some_and(|cur| cur.timestamp <= u.timestamp) {
                            p.remove(&key);
                        }
                    }
                }
                notify_queue_changed(&queue_listener);
                rejected_writes.set(rejected_writes.get().saturating_add(updates.len() as u32));
                *last_reject_reason.borrow_mut() = Some(reason);
                backoff_ms = DEBOUNCE_MS;
            }
        }
    }
}

/// The fate of one flush attempt (ADR 0003 phase 3).
enum SendOutcome {
    Sent,
    /// Transient (rate limit, network, 5xx, room cache not ready): re-queue
    /// and retry with backoff.
    Retryable(Vec<CellUpdate>),
    /// Permanent: retrying can never succeed. The caller drops the batch,
    /// reverts the cells to converged state, and surfaces `reason`.
    Rejected {
        updates: Vec<CellUpdate>,
        reason: String,
    },
}

/// Whether a send error can never succeed on retry. Unknown errors default to
/// retryable — wrongly retrying is bounded noise, wrongly dropping is loss.
fn is_permanent_send_error(err: &matrix_sdk::Error) -> bool {
    use matrix_sdk::ruma::api::client::error::ErrorKind;
    if let matrix_sdk::Error::Http(http) = err {
        if let Some(kind) = http.client_api_error_kind() {
            return matches!(
                kind,
                ErrorKind::Forbidden { .. } | ErrorKind::UnknownToken { .. } | ErrorKind::TooLarge
            );
        }
    }
    false
}

/// Send a coalesced batch of updates. Fails closed on a non-encrypted room —
/// as a REJECTION the caller must surface, not a silent drop.
async fn send_batch(client: &Client, room_id: &OwnedRoomId, batch: Vec<CellUpdate>) -> SendOutcome {
    let Some(room) = client.get_room(room_id) else {
        // Room not available yet; retry the whole batch on the next pass.
        return SendOutcome::Retryable(batch);
    };

    // Fail closed: never emit workspace data into a non-encrypted room. This is
    // a permanent condition (see ARCHITECTURE_REVIEW.md §4.2) — previously a
    // SILENT drop; now a surfaced rejection.
    if !room.encryption_state().is_encrypted() {
        return SendOutcome::Rejected {
            updates: batch,
            reason: "this workspace room is not end-to-end encrypted".to_string(),
        };
    }

    if batch.is_empty() {
        return SendOutcome::Sent;
    }

    // Send the coalesced flush as ONE batch event (the queue already deduped to
    // the latest value per cell, and each cell is independent LWW, so order
    // doesn't matter). A flurry of edits — or a first-reorder `_order` backfill
    // across many rows — is then a single event rather than one per cell, which
    // keeps it under `rc_message`. All-or-nothing per attempt.
    let result = if batch.len() == 1 {
        let content: tables_over_matrix::CellUpdateEventContent = batch[0].clone().into();
        room.send(content).await.map(|_| ())
    } else {
        let content = tables_over_matrix::CellBatchEventContent::from_updates(&batch);
        room.send(content).await.map(|_| ())
    };

    match result {
        Ok(()) => SendOutcome::Sent,
        Err(e) if is_permanent_send_error(&e) => SendOutcome::Rejected {
            updates: batch,
            reason: format!("the server rejected the change: {e}"),
        },
        Err(_) => SendOutcome::Retryable(batch),
    }
}
