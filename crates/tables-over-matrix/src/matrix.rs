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
    use matrix_sdk::crypto::CollectStrategy;
    use matrix_sdk::encryption::{BackupDownloadStrategy, EncryptionSettings};
    use matrix_sdk::{
        config::SyncSettings,
        room::Room,
        ruma::{
            events::macros::EventContent, MilliSecondsSinceUnixEpoch, OwnedDeviceId, OwnedEventId,
            OwnedRoomId, UInt,
        },
        Client,
    };
    use serde::{Deserialize, Serialize};
    use tracing::{debug, info};

    /// Complete a registration's user-interactive auth, one stage at a time.
    ///
    /// Registration is a handshake, not a single call: the server answers the
    /// first request with 401 and a list of FLOWS, each an ordered set of
    /// stages. This walks whichever flow it can satisfy, resubmitting the same
    /// request with the next stage's auth data until the server accepts it.
    ///
    /// Two stages are supported, which is what a TideWork-shaped homeserver
    /// needs:
    ///
    ///   * `m.login.registration_token` — the invitation-token flow. This is the
    ///     answer to "open registration is an abuse magnet, but creating every
    ///     account by hand does not scale": the operator mints one token, shares
    ///     it with their team, and people sign themselves up.
    ///   * `m.login.dummy` — the no-op stage an open server asks for.
    ///
    /// Anything else (captcha, email, terms) is reported by NAME rather than as
    /// a generic failure, because the user can act on "this server requires a
    /// captcha" and cannot act on "registration failed".
    pub async fn complete_registration(
        client: &Client,
        base: matrix_sdk::ruma::api::client::account::register::v3::Request,
        registration_token: Option<&str>,
    ) -> Result<()> {
        use matrix_sdk::ruma::api::client::{account::register, uiaa};

        const DUMMY: &str = "m.login.dummy";
        const TOKEN: &str = "m.login.registration_token";

        // Bounded: each iteration must complete a stage, and a server that
        // keeps asking for one we have already satisfied would otherwise spin
        // forever.
        let mut attempts = 0;
        let mut request: register::v3::Request = base;

        loop {
            let err = match client.matrix_auth().register(request.clone()).await {
                Ok(_) => return Ok(()),
                Err(e) => e,
            };

            let Some(info) = err.as_uiaa_response() else {
                return Err(anyhow::anyhow!("registration failed: {err}"));
            };

            attempts += 1;
            if attempts > 4 {
                return Err(anyhow::anyhow!(
                    "registration did not complete after {attempts} authentication stages"
                ));
            }

            let completed: Vec<String> = info.completed.iter().map(|s| s.to_string()).collect();
            let done = |stage: &str| completed.iter().any(|c| c == stage);

            // Every stage this server would accept, across all its flows.
            let offered: Vec<String> = info
                .flows
                .iter()
                .flat_map(|f| f.stages.iter().map(|s| s.to_string()))
                .collect();
            let offers = |stage: &str| offered.iter().any(|o| o == stage);

            let auth = if offers(TOKEN) && !done(TOKEN) {
                let Some(token) = registration_token else {
                    return Err(anyhow::anyhow!(
                        "this homeserver requires an invitation token to register"
                    ));
                };
                let mut stage = uiaa::RegistrationToken::new(token.to_owned());
                stage.session = info.session.clone();
                uiaa::AuthData::RegistrationToken(stage)
            } else if offers(DUMMY) && !done(DUMMY) {
                let mut stage = uiaa::Dummy::new();
                stage.session = info.session.clone();
                uiaa::AuthData::Dummy(stage)
            } else {
                let remaining: Vec<&str> = offered
                    .iter()
                    .map(|s| s.as_str())
                    .filter(|s| !done(s))
                    .collect();
                return Err(anyhow::anyhow!(
                    "this homeserver requires a registration step TideWork cannot do: {}",
                    if remaining.is_empty() {
                        "none offered".to_owned()
                    } else {
                        remaining.join(", ")
                    }
                ));
            };

            request.auth = Some(auth);
        }
    }

    /// Events per /messages round-trip.
    ///
    /// Large on purpose: a round-trip costs far more than the events in it.
    /// The coverage stop below is page-granular, so smaller pages would let a
    /// walk stop after fewer EVENTS — but only by paying for more round-trips,
    /// which trades a cheap saving for an expensive one. Under this size a room
    /// is a single request and there is nothing left to save.
    pub const DEFAULT_PAGE_LIMIT: u32 = 1000;

    /// Events per round-trip when resuming from a snapshot.
    ///
    /// Deliberately much smaller than [`DEFAULT_PAGE_LIMIT`], because the two
    /// walks want opposite things. A cold start reads a whole room and wants as
    /// few round-trips as possible. An incremental start expects a handful of
    /// new events and stops at the first page that trails the marker — so a
    /// 1000-event page means fetching and DECRYPTING a thousand events to pick
    /// up five, on every load, growing with the room rather than with what
    /// changed.
    ///
    /// Measured: seeding through the CLI cost ~1.5s per single-cell edit, and
    /// the walk stats showed every one of those loads pulling a full
    /// 1000-event page to reach "stopped: reached marker".
    pub const INCREMENTAL_PAGE_LIMIT: u32 = 100;

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

    /// Enable Secure Backup + Recovery on `client` and return the **recovery
    /// key** the user must save. Bootstraps secret storage and key backup and
    /// waits for this device's room keys to finish uploading, so another
    /// device can later restore encrypted workspace history with the key.
    ///
    /// Shared by [`MatrixClient::enable_recovery`] (native/tests) and the WASM
    /// bridge so the race handling below exists in exactly one place: with
    /// [`default_encryption_settings`]'s `auto_enable_backups`, a background
    /// task may create the server-side backup between login and this call. If
    /// it wins the race, `Recovery::enable()` fails with
    /// `BackupExistsOnServer` (the client hasn't connected to the new backup
    /// locally yet) — in that case wait for the auto-enable to settle and
    /// retry; the retry skips backup creation and only bootstraps secret
    /// storage around the existing backup.
    pub async fn enable_recovery(client: &Client) -> Result<String> {
        enable_recovery_inner(client, None).await
    }

    /// Like [`enable_recovery`], but derive the secret-storage key from a
    /// **passphrase** (PBKDF2) rather than a random recovery key. This is the
    /// basis for passkey / WebAuthn-PRF custody: the PRF output is the
    /// passphrase, so the SSSS key is unlocked by a biometric gesture instead of
    /// a saved string. The returned recovery key still works as a break-glass
    /// fallback, and a later device restores by passing the **same passphrase**
    /// to [`MatrixClient::recover_with_key`] (the SDK's `recover` accepts either
    /// a passphrase or a Base58 recovery key).
    pub async fn enable_recovery_with_passphrase(
        client: &Client,
        passphrase: &str,
    ) -> Result<String> {
        enable_recovery_inner(client, Some(passphrase)).await
    }

    /// Re-key Secure Backup to a **passphrase** (a passkey's PRF secret),
    /// rotating the secret-storage key and re-uploading the secrets under it.
    /// Unlike [`enable_recovery_with_passphrase`], this is for an account that
    /// ALREADY has recovery — a legacy raw-recovery-key account migrating to
    /// passkey custody. The device must already hold the secrets (i.e. have
    /// recovered) so they can be re-uploaded under the new key. Returns a fresh
    /// break-glass recovery key; the old recovery key stops working.
    ///
    /// The builder chain is kept inline (not bound to a `let`) so the
    /// intermediate `Encryption`/`Recovery` temporaries live across the `.await`
    /// (mirrors [`try_enable_recovery`]).
    pub async fn reset_recovery_with_passphrase(
        client: &Client,
        passphrase: &str,
    ) -> Result<String> {
        client
            .encryption()
            .recovery()
            .reset_key()
            .with_passphrase(passphrase)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to reset recovery key: {e}"))
    }

    /// Reset Secure Backup to a fresh **random recovery key** (Base58), rotating
    /// the secret-storage key and re-uploading the secrets under it. Like
    /// [`reset_recovery_with_passphrase`] but keyed by a random key, not a
    /// passphrase — for a signed-in, recovered device that wants a brand-new
    /// typed recovery key (the old one was lost, or is being rotated). Returns
    /// the new recovery key; the old key (and any passphrase/passkey) stops
    /// working. The device must already hold the secrets so they can be
    /// re-uploaded under the new key.
    pub async fn reset_recovery(client: &Client) -> Result<String> {
        client
            .encryption()
            .recovery()
            .reset_key()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to reset recovery key: {e}"))
    }

    /// Mint a Matrix OpenID token proving the signed-in user's identity to a
    /// third party (e.g. the billing Worker) WITHOUT exposing the access token.
    /// The verifier checks it against the homeserver's federation openid
    /// userinfo endpoint (`GET /_matrix/federation/v1/openid/userinfo`). Account-
    /// level, so it works before E2E unlock. Returns JSON
    /// `{ access_token, matrix_server_name }`.
    pub async fn request_openid_token(client: &Client) -> Result<String> {
        use matrix_sdk::ruma::api::client::account::request_openid_token::v3::Request;
        let user_id = client
            .user_id()
            .ok_or_else(|| anyhow::anyhow!("Not signed in"))?
            .to_owned();
        let resp = client
            .send(Request::new(user_id))
            .await
            .map_err(|e| anyhow::anyhow!("OpenID token request failed: {e}"))?;
        Ok(serde_json::json!({
            "access_token": resp.access_token,
            "matrix_server_name": resp.matrix_server_name.as_str(),
        })
        .to_string())
    }

    /// One enable attempt, optionally keyed by a passphrase. The builder chain is
    /// kept inline (not bound to a `let`) so the intermediate `Encryption` /
    /// `Recovery` temporaries it borrows live across the `.await`.
    async fn try_enable_recovery(
        client: &Client,
        passphrase: Option<&str>,
    ) -> Result<String, matrix_sdk::encryption::recovery::RecoveryError> {
        match passphrase {
            Some(p) => {
                client
                    .encryption()
                    .recovery()
                    .enable()
                    .wait_for_backups_to_upload()
                    .with_passphrase(p)
                    .await
            }
            None => {
                client
                    .encryption()
                    .recovery()
                    .enable()
                    .wait_for_backups_to_upload()
                    .await
            }
        }
    }

    /// Shared enable logic with the auto-backup-race retry (see the doc on
    /// [`enable_recovery`]), parameterised by an optional passphrase.
    async fn enable_recovery_inner(client: &Client, passphrase: Option<&str>) -> Result<String> {
        use matrix_sdk::encryption::recovery::RecoveryError;

        match try_enable_recovery(client, passphrase).await {
            Ok(recovery_key) => {
                info!("Secure backup + recovery enabled");
                Ok(recovery_key)
            }
            Err(RecoveryError::BackupExistsOnServer) => {
                wait_until_backups_enabled(client, 40).await?;
                let recovery_key = try_enable_recovery(client, passphrase).await.map_err(|e| {
                    anyhow::anyhow!("Failed to enable recovery after auto-backup settled: {e}")
                })?;
                info!("Secure backup + recovery enabled (after auto-backup race)");
                Ok(recovery_key)
            }
            Err(e) => Err(anyhow::anyhow!("Failed to enable recovery: {e}")),
        }
    }

    /// Wait (bounded: `max_polls` × 250ms) for the SDK's `auto_enable_backups`
    /// background task to finish connecting this client to its key backup.
    async fn wait_until_backups_enabled(client: &Client, max_polls: u32) -> Result<()> {
        for _ in 0..max_polls {
            if client.encryption().backups().are_enabled().await {
                return Ok(());
            }
            matrix_sdk::sleep::sleep(std::time::Duration::from_millis(250)).await;
        }
        anyhow::bail!("Key backup did not finish enabling in time (auto_enable_backups race)")
    }

    // ── Custom Matrix Event ─────────────────────────────────────────────

    /// The Matrix event type string for cell updates.
    ///
    /// Uses the reverse-DNS convention for custom event types as
    /// recommended by the Matrix spec. This is a timeline (message-like)
    /// event, not a state event, since each cell write is an append to
    /// the room timeline.
    pub const CELL_UPDATE_EVENT_TYPE: &str = "io.tidework.cell.update";

    /// Event type for a **batch** of cell updates sent as a single timeline
    /// event. Discrete multi-cell operations (creating a table — ~30 cells for a
    /// template — adding a column, a coalesced flush of rapid edits) send one
    /// batch event instead of one event per cell, so they don't burst past the
    /// homeserver's `rc_message` rate limit (Synapse defaults to 0.2/s, burst
    /// 10; ~30 single events take ~120s and a mid-flush reload loses the rest).
    pub const CELL_BATCH_EVENT_TYPE: &str = "io.tidework.cell.batch";

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
    #[ruma_event(type = "io.tidework.cell.update", kind = MessageLike)]
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

    /// Matrix event content for a **batch** of cell updates (see
    /// [`CELL_BATCH_EVENT_TYPE`]). Carries the same per-cell payloads as
    /// [`CellUpdateEventContent`], just many in one event. The receiver applies
    /// each cell with LWW exactly as if they had arrived as individual events;
    /// all cells share the event's `origin_server_ts` tiebreaker.
    #[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
    #[ruma_event(type = "io.tidework.cell.batch", kind = MessageLike)]
    pub struct CellBatchEventContent {
        /// Wire format version for forward compatibility.
        #[serde(default = "default_version")]
        pub version: u8,
        /// The cells in this batch.
        pub cells: Vec<CellUpdateEventContent>,
    }

    impl CellBatchEventContent {
        /// Build a batch event content from cell updates.
        pub fn from_updates(updates: &[CellUpdate]) -> Self {
            Self {
                version: CELL_UPDATE_VERSION,
                cells: updates.iter().cloned().map(Into::into).collect(),
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
                // Forward encrypted room history to a user when they are invited
                // (MSC4268), so a new collaborator can decrypt and materialize
                // workspace data written *before* they joined. Without this the
                // SDK only shares the current Megolm session, leaving pre-join
                // history undecryptable and the workspace silently incomplete
                // (review §4.2 / ADR 0001). Requires a homeserver that exposes
                // the inviter in the invite stripped state (Synapse does; Conduit
                // does not — which is why the integration harness runs Synapse).
                // See the `collaborator_history_matrix` test for the full trace.
                .with_enable_share_history_on_invite(true)
                .with_encryption_settings(default_encryption_settings())
                // Share Megolm keys only with devices cross-signed by their
                // owner's identity (not "all devices"): a device injected by a
                // malicious homeserver/MAS isn't signed by the user's own
                // identity, so it receives no future keys — closing the
                // future-read-via-bump reconstruction. See ADR 0001 addendum.
                .with_room_key_recipient_strategy(CollectStrategy::IdentityBasedStrategy)
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
                .initial_device_display_name("TideWork Client")
                .await
                .map_err(|e| anyhow::anyhow!("Failed to login: {e}"))?;

            info!("Logged in as {}", username);
            Ok(())
        }

        /// The account's current global display name (None if unset).
        pub async fn get_display_name(&self) -> Result<Option<String>> {
            self.client
                .account()
                .get_display_name()
                .await
                .map_err(|e| anyhow::anyhow!("Failed to fetch display name: {e}"))
        }

        /// Set the account's global Matrix display name (issue 1c8b3855).
        pub async fn set_display_name(&self, name: &str) -> Result<()> {
            self.client
                .account()
                .set_display_name(Some(name))
                .await
                .map_err(|e| anyhow::anyhow!("Failed to set display name: {e}"))?;
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

        /// Send many cell updates as a **single** batch event
        /// ([`CellBatchEventContent`]). One event regardless of cell count, so a
        /// big multi-cell operation doesn't burst past `rc_message`.
        pub async fn send_cell_batch(&self, updates: &[CellUpdate]) -> Result<OwnedEventId> {
            let room = self.get_room()?;
            let content = CellBatchEventContent::from_updates(updates);
            debug!("Sending cell batch: {} cells", updates.len());
            let response = room
                .send(content)
                .await
                .map_err(|e| anyhow::anyhow!("Failed to send cell batch: {e}"))?;
            Ok(response.event_id)
        }

        /// Parse a raw Matrix event JSON into the cell updates it carries.
        ///
        /// Handles both a single [`CELL_UPDATE_EVENT_TYPE`] event (→ one update)
        /// and a [`CELL_BATCH_EVENT_TYPE`] event (→ one per cell, all sharing the
        /// event's `origin_server_ts` tiebreaker). Returns an empty vec for any
        /// other event type or a parse failure. This is the read path used by
        /// cold start and sync.
        pub fn extract_cell_updates(event_json: &str) -> Vec<ReceivedCellUpdate> {
            let Ok(raw) = serde_json::from_str::<serde_json::Value>(event_json) else {
                return Vec::new();
            };
            let Some(event_type) = raw.get("type").and_then(|t| t.as_str()) else {
                return Vec::new();
            };
            if event_type != CELL_UPDATE_EVENT_TYPE && event_type != CELL_BATCH_EVENT_TYPE {
                return Vec::new();
            }

            // Shared envelope metadata (event id + server timestamp tiebreaker).
            let Some(event_id) = raw
                .get("event_id")
                .and_then(|v| v.as_str())
                .and_then(|s| OwnedEventId::try_from(s).ok())
            else {
                return Vec::new();
            };
            let origin_server_ts = raw
                .get("origin_server_ts")
                .and_then(|v| v.as_u64())
                .and_then(|ms| UInt::try_from(ms).ok())
                .map(MilliSecondsSinceUnixEpoch)
                .unwrap_or_else(|| MilliSecondsSinceUnixEpoch(UInt::from(0u32)));

            let Some(content) = raw.get("content") else {
                return Vec::new();
            };

            if event_type == CELL_BATCH_EVENT_TYPE {
                let Ok(batch) = serde_json::from_value::<CellBatchEventContent>(content.clone())
                else {
                    return Vec::new();
                };
                return batch
                    .cells
                    .into_iter()
                    .map(|c| ReceivedCellUpdate {
                        update: c.into(),
                        event_id: event_id.clone(),
                        origin_server_ts,
                    })
                    .collect();
            }

            // Single cell update.
            match serde_json::from_value::<CellUpdateEventContent>(content.clone()) {
                Ok(cell) => vec![ReceivedCellUpdate {
                    update: cell.into(),
                    event_id,
                    origin_server_ts,
                }],
                Err(_) => Vec::new(),
            }
        }

        /// Best-effort read of a raw event's `origin_server_ts` (ms since the
        /// epoch). The incremental cold start uses this to bound back-pagination
        /// at the snapshot marker without fully decoding every event.
        pub fn extract_origin_server_ts(event_json: &str) -> Option<u64> {
            serde_json::from_str::<serde_json::Value>(event_json)
                .ok()?
                .get("origin_server_ts")?
                .as_u64()
        }

        /// Best-effort read of a raw event's `event_id`.
        ///
        /// Undecryptable events are remembered BY ID rather than merely counted,
        /// so the client can re-fetch exactly those events once the missing room
        /// key arrives and clear the warning. A count can only ever go up.
        pub fn extract_event_id(event_json: &str) -> Option<String> {
            Some(
                serde_json::from_str::<serde_json::Value>(event_json)
                    .ok()?
                    .get("event_id")?
                    .as_str()?
                    .to_string(),
            )
        }

        /// Parse a raw Matrix event JSON into a single `CellUpdate`, if it is a
        /// single `io.tidework.cell.update` event. (Batch events return `None`;
        /// use [`extract_cell_updates`] for the read path.) Retained for callers
        /// that only ever deal with single events.
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
        ///
        /// Timeout ZERO, deliberately. `SyncSettings::default()` long-polls: the
        /// server holds the request open until something happens, so once an
        /// account was caught up EVERY CLI command blocked for the full poll —
        /// measured at ~30s each for `workspace list`, `table list` and
        /// `table show`, against 65ms for `whoami`, which does not sync. It read
        /// as a workspace-size problem and is not one; it is the same 30s
        /// whatever the room contains.
        ///
        /// Long-polling is right for a client that stays open and wants to be
        /// told about changes. A one-shot command wants the opposite: whatever
        /// the server has right now. Per the Matrix spec, timeout=0 returns
        /// immediately.
        pub async fn sync_once(&self) -> Result<()> {
            let settings = SyncSettings::default().timeout(std::time::Duration::from_secs(0));
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
            enable_recovery(&self.client).await
        }

        /// Enable Secure Backup + Recovery keyed by a **passphrase** instead of a
        /// random recovery key — the basis for passkey / WebAuthn-PRF custody
        /// (the PRF output is the passphrase). See
        /// [`enable_recovery_with_passphrase`]. Restore later with the same
        /// passphrase via [`recover_with_key`](Self::recover_with_key).
        pub async fn enable_recovery_with_passphrase(&self, passphrase: &str) -> Result<String> {
            enable_recovery_with_passphrase(&self.client, passphrase).await
        }

        /// Restore secrets (including the backup decryption key) from Secure
        /// Backup. `recovery_key` may be either a Base58 recovery key **or a
        /// passphrase** (the SDK's `open_secret_store` accepts both) — so this is
        /// also the unlock path for passphrase / passkey-PRF custody. Afterwards
        /// the SDK downloads room keys from backup so this device can decrypt
        /// history that was sent before it existed — the multi-device promise.
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

        /// Block until this device's room keys have finished uploading to
        /// secure backup.
        ///
        /// The SDK backs keys up from a background task, which is fine for a
        /// client that stays open and wrong for one that does not: a process
        /// that sends events and exits can take the only copy of those megolm
        /// sessions with it. Devices that already existed got them over
        /// to-device at send time, but any device created LATER has only backup
        /// to restore from — so those events are undecryptable there, and stay
        /// that way, because nothing ever revisits them.
        ///
        /// Measured, not theorised: a benchmark account seeded 3000 edits from
        /// one short-lived process, and a second login on the same account then
        /// found 2903 events it could not decrypt, unchanged after 31 s of
        /// retries.
        ///
        /// A no-op when backup is not enabled — nowhere to upload to.
        pub async fn wait_for_key_backup(&self) -> Result<()> {
            if !self.client.encryption().backups().are_enabled().await {
                return Ok(());
            }
            self.client
                .encryption()
                .backups()
                .wait_for_steady_state()
                .await
                .map_err(|e| anyhow::anyhow!("key backup upload failed: {e}"))?;
            Ok(())
        }

        /// Whether a key backup is enabled for this client (ADR 0001 Phase A).
        /// True once recovery/backup setup has completed — lets callers confirm
        /// "backup on" directly rather than inferring it from a restore working.
        pub fn backup_exists(&self) -> bool {
            use matrix_sdk::encryption::backups::BackupState;
            matches!(
                self.client.encryption().backups().state(),
                BackupState::Enabled
            )
        }
    }

    // ── Native CLI support: persistent SQLite store + session save/restore ──
    //
    // The WASM bridge persists sessions to a JS-side blob and uses an IndexedDB
    // store; a native CLI persists to disk and uses a SQLite store. These methods
    // mirror the bridge's session blob shape so the two stay format-compatible.
    #[cfg(feature = "matrix-native")]
    impl MatrixClient {
        /// Build a client backed by a persistent SQLite store at `store_path`, so
        /// the device identity, crypto keys, and session survive across runs.
        pub async fn with_sqlite_store(
            homeserver_url: &str,
            store_path: &std::path::Path,
        ) -> Result<Self> {
            let client = Client::builder()
                .homeserver_url(homeserver_url)
                .sqlite_store(store_path, None)
                .with_enable_share_history_on_invite(true)
                .with_encryption_settings(default_encryption_settings())
                // Share Megolm keys only with devices cross-signed by their
                // owner's identity (not "all devices"): a device injected by a
                // malicious homeserver/MAS isn't signed by the user's own
                // identity, so it receives no future keys — closing the
                // future-read-via-bump reconstruction. See ADR 0001 addendum.
                .with_room_key_recipient_strategy(CollectStrategy::IdentityBasedStrategy)
                .handle_refresh_tokens()
                .build()
                .await
                .map_err(|e| anyhow::anyhow!("Failed to build client: {e}"))?;
            Ok(Self {
                client,
                room_id: None,
            })
        }

        /// Register a new account, then log in as it.
        ///
        /// Exists so test and benchmark accounts can be created without a
        /// browser. The web client has had this since the beginning
        /// (`bridge_matrix::register`), but that path is `#[cfg(wasm)]`, so
        /// every native caller — the CLI, any harness — previously had to go
        /// around the product: raw CS-API calls, or `mas-cli` on the server.
        ///
        /// Mirrors the wasm flow: probe with a bare request and walk whichever
        /// UIA stages the server asks for — the invitation token when it wants
        /// one, the dummy stage otherwise. Production closes registration
        /// entirely and its accounts come from MAS.
        pub async fn register(
            homeserver_url: &str,
            store_path: &std::path::Path,
            username: &str,
            password: &str,
            // An invitation token, when the homeserver requires one.
            registration_token: Option<&str>,
        ) -> Result<Self> {
            use matrix_sdk::ruma::api::client::account::register;

            let this = Self::with_sqlite_store(homeserver_url, store_path).await?;

            let mut request = register::v3::Request::new();
            request.username = Some(username.to_owned());
            request.password = Some(password.to_owned());
            request.initial_device_display_name = Some("TideWork CLI".to_owned());

            complete_registration(&this.client, request, registration_token).await?;

            Ok(this)
        }

        /// Serialize the active session for on-disk persistence. Mirrors the WASM
        /// bridge blob (`kind`/`userId`/`deviceId`/`accessToken`[`/refreshToken`/
        /// `clientId`]) so the formats stay compatible.
        pub fn session_json(&self) -> Option<String> {
            Self::serialize_session_blob(&self.client)
        }

        /// Shared session serializer used by `session_json` and the
        /// token-refresh persistence task (which holds a `Client`, not `&self`).
        fn serialize_session_blob(client: &Client) -> Option<String> {
            let data = match client.session()? {
                matrix_sdk::AuthSession::Matrix(ms) => serde_json::json!({
                    "kind": "password",
                    "userId": ms.meta.user_id.to_string(),
                    "deviceId": ms.meta.device_id.to_string(),
                    "accessToken": ms.tokens.access_token,
                }),
                matrix_sdk::AuthSession::OAuth(os) => serde_json::json!({
                    "kind": "oauth",
                    "userId": os.user.meta.user_id.to_string(),
                    "deviceId": os.user.meta.device_id.to_string(),
                    "accessToken": os.user.tokens.access_token,
                    "refreshToken": os.user.tokens.refresh_token,
                    "clientId": os.client_id.as_str(),
                }),
                _ => return None,
            };
            serde_json::to_string(&data).ok()
        }

        /// Re-persist the session whenever the SDK rotates the OAuth tokens, so
        /// the next run restores with a *live* refresh token instead of the dead
        /// one captured at sign-in. Without this, refresh works in-memory for the
        /// current process but is lost on exit — MAS rotates the refresh token,
        /// the stored blob keeps the old one, and the next run fails
        /// `invalid_grant`. Mirrors the WASM bridge's `start_token_persistence`.
        /// `on_tokens` receives the fresh `session_json()` string; runs as a
        /// detached task and does not block. Call once on a restored/signed-in
        /// client.
        pub fn persist_session_on_refresh<F>(&self, on_tokens: F)
        where
            F: Fn(String) + Send + 'static,
        {
            let client = self.client.clone();
            let mut changes = client.subscribe_to_session_changes();
            tokio::spawn(async move {
                loop {
                    match changes.recv().await {
                        Ok(matrix_sdk::SessionChange::TokensRefreshed) => {
                            if let Some(blob) = MatrixClient::serialize_session_blob(&client) {
                                on_tokens(blob);
                            }
                        }
                        // UnknownToken (refresh failed / token revoked): the
                        // request layer surfaces the auth error; nothing to save.
                        Ok(_) => {}
                        // Lagged past the buffer or the sender dropped: stop.
                        Err(_) => break,
                    }
                }
            });
        }

        /// Restore a client from a saved session blob against the same SQLite
        /// store (so the persisted device + crypto keys are reused).
        pub async fn restore_with_store(
            homeserver_url: &str,
            store_path: &std::path::Path,
            session_json: &str,
        ) -> Result<Self> {
            use matrix_sdk::authentication::oauth::{
                ClientId, OAuthSession as SdkOAuthSession, UserSession,
            };
            use matrix_sdk::ruma::{OwnedDeviceId, OwnedUserId};
            use matrix_sdk::{AuthSession, SessionMeta, SessionTokens};

            #[derive(serde::Deserialize)]
            struct Saved {
                #[serde(rename = "userId")]
                user_id: String,
                #[serde(rename = "deviceId")]
                device_id: String,
                #[serde(rename = "accessToken")]
                access_token: String,
                #[serde(default)]
                kind: Option<String>,
                #[serde(rename = "refreshToken", default)]
                refresh_token: Option<String>,
                #[serde(rename = "clientId", default)]
                client_id: Option<String>,
            }
            let saved: Saved = serde_json::from_str(session_json)
                .map_err(|e| anyhow::anyhow!("Invalid session JSON: {e}"))?;

            let client = Client::builder()
                .homeserver_url(homeserver_url)
                .sqlite_store(store_path, None)
                .with_enable_share_history_on_invite(true)
                .with_encryption_settings(default_encryption_settings())
                // Share Megolm keys only with devices cross-signed by their
                // owner's identity (not "all devices"): a device injected by a
                // malicious homeserver/MAS isn't signed by the user's own
                // identity, so it receives no future keys — closing the
                // future-read-via-bump reconstruction. See ADR 0001 addendum.
                .with_room_key_recipient_strategy(CollectStrategy::IdentityBasedStrategy)
                .handle_refresh_tokens()
                .build()
                .await
                .map_err(|e| anyhow::anyhow!("Failed to build client: {e}"))?;

            let user_id: OwnedUserId = saved
                .user_id
                .as_str()
                .try_into()
                .map_err(|_| anyhow::anyhow!("Invalid user id in session"))?;
            let device_id: OwnedDeviceId = saved.device_id.into();
            let meta = SessionMeta { user_id, device_id };

            let sdk_session: AuthSession = if saved.kind.as_deref() == Some("oauth") {
                let client_id = saved
                    .client_id
                    .ok_or_else(|| anyhow::anyhow!("OAuth session blob missing clientId"))?;
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
                .map_err(|e| anyhow::anyhow!("Failed to restore session: {e}"))?;

            Ok(Self {
                client,
                room_id: None,
            })
        }

        /// The logged-in user id, if a session is active.
        pub fn user_id(&self) -> Option<String> {
            self.client.user_id().map(|u| u.to_string())
        }

        /// Whether the homeserver delegates auth to an OAuth 2.0 provider (MAS /
        /// MSC3861) — i.e. it advertises authorization-server metadata. Builds a
        /// throwaway client just to probe; production runs MAS, so password
        /// login is disabled and this is the only way in.
        pub async fn homeserver_supports_oauth(homeserver_url: &str) -> Result<bool> {
            let client = Client::builder()
                .homeserver_url(homeserver_url)
                .build()
                .await
                .map_err(|e| anyhow::anyhow!("Failed to connect: {e}"))?;
            Ok(client.oauth().server_metadata().await.is_ok())
        }

        /// Begin an OAuth 2.0 login: dynamically register this app with the
        /// authorization server (a public client — PKCE carries the proof) and
        /// return the authorization URL to open in a browser.
        ///
        /// The PKCE verifier lives inside `self.client`, so [`oauth_finish`] must
        /// be called on the *same* `MatrixClient` instance. `redirect_uri` is
        /// where the browser is sent back with the authorization code — for a
        /// native CLI this is a `http://127.0.0.1:<port>/…` loopback the process
        /// listens on.
        ///
        /// [`oauth_finish`]: MatrixClient::oauth_finish
        pub async fn oauth_start(&self, redirect_uri: &str) -> Result<String> {
            use matrix_sdk::authentication::oauth::registration::ClientMetadata;
            use matrix_sdk::authentication::oauth::ClientRegistrationData;
            use matrix_sdk::ruma::serde::Raw;

            let redirect: url::Url = redirect_uri
                .parse()
                .map_err(|e| anyhow::anyhow!("Invalid redirect URI: {e}"))?;

            // A native, public OAuth client. PKCE (not a secret) authenticates
            // the token exchange. `client_uri` must be a real https URL — MAS
            // rejects a loopback/redirect-derived one ("invalid client_uri") —
            // so point it at the product homepage; the loopback only appears in
            // `redirect_uris`, which a native client is allowed to use.
            let metadata_json = serde_json::json!({
                "client_name": "TideWork CLI",
                "client_uri": "https://tidework.io/",
                "application_type": "native",
                "redirect_uris": [redirect],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
            });
            let metadata: Raw<ClientMetadata> = Raw::from_json_string(metadata_json.to_string())
                .map_err(|e| anyhow::anyhow!("Invalid client metadata: {e}"))?;
            let registration_data: ClientRegistrationData = metadata.into();

            let auth_data = self
                .client
                .oauth()
                .login(redirect, None, Some(registration_data), None)
                .build()
                .await
                .map_err(|e| anyhow::anyhow!("Failed to start OAuth login: {e}"))?;

            Ok(auth_data.url.to_string())
        }

        /// Complete an OAuth login with the URL the browser was finally
        /// redirected to (it carries the authorization code + state). Exchanges
        /// the code for tokens on the client started by [`oauth_start`].
        ///
        /// [`oauth_start`]: MatrixClient::oauth_start
        pub async fn oauth_finish(&self, redirected_url: &str) -> Result<()> {
            let url: url::Url = redirected_url
                .parse()
                .map_err(|e| anyhow::anyhow!("Invalid redirect URL: {e}"))?;
            self.client
                .oauth()
                .finish_login(url.into())
                .await
                .map_err(|e| anyhow::anyhow!("Failed to finish OAuth login: {e}"))?;
            Ok(())
        }

        /// Create a new encrypted room, tag it as a TideWork workspace, and
        /// return its room id. Mirrors the WASM bridge's `createRoom`: a private
        /// E2E-encrypted room carrying the `io.tidework.workspace` marker.
        pub async fn create_workspace_room(&self, name: &str) -> Result<String> {
            use matrix_sdk::ruma::api::client::room::create_room::v3::{
                Request as CreateRoomRequest, RoomPreset,
            };

            let mut request = CreateRoomRequest::new();
            request.name = Some(name.to_owned());
            request.preset = Some(RoomPreset::PrivateChat);

            let room = self
                .client
                .create_room(request)
                .await
                .map_err(|e| anyhow::anyhow!("Failed to create room: {e}"))?;

            // Encrypt before any workspace data is written.
            room.enable_encryption()
                .await
                .map_err(|e| anyhow::anyhow!("Failed to enable encryption: {e}"))?;

            room.send_state_event_for_key("", WorkspaceMarkerEventContent { workspace: true })
                .await
                .map_err(|e| anyhow::anyhow!("Failed to tag room as workspace: {e}"))?;

            Ok(room.room_id().to_string())
        }

        /// List joined rooms tagged as TideWork workspaces. Requires a prior
        /// sync so the SDK knows the joined room list. Returns `(room_id, name)`.
        pub async fn list_workspaces(&self) -> Result<Vec<WorkspaceInfo>> {
            use matrix_sdk::ruma::events::StateEventType;

            let marker_type = StateEventType::from(WORKSPACE_STATE_TYPE.to_owned());
            let mut out = Vec::new();
            for room in self.client.joined_rooms() {
                let is_workspace = room
                    .get_state_event(marker_type.clone(), "")
                    .await
                    .ok()
                    .flatten()
                    .and_then(|raw| {
                        let json: serde_json::Value = serde_json::to_value(&raw).ok()?;
                        json.get("content")?.get("workspace")?.as_bool()
                    })
                    .unwrap_or(false);
                if is_workspace {
                    out.push(WorkspaceInfo {
                        room_id: room.room_id().to_string(),
                        name: room.name().unwrap_or_default(),
                    });
                }
            }
            Ok(out)
        }

        /// Paginate the current room's history (newest-first) and return every
        /// cell update found, ready to replay into a `Workspace` via
        /// `apply_update`. This is the native cold-start: mirrors the WASM
        /// bridge's `ConnectedWorkspace::create` history replay (large pages to
        /// minimise round-trips; the SDK decrypts each event in transit).
        pub async fn load_room_cell_updates(&self) -> Result<Vec<CellUpdate>> {
            Ok(self.load_room_cell_updates_since(0).await?.0)
        }

        /// Paginate history backwards, stopping once events are older than
        /// `marker_ts`, and return the updates found plus the newest
        /// `origin_server_ts` seen.
        ///
        /// `marker_ts = 0` means "no marker", i.e. the full walk that
        /// [`load_room_cell_updates`] performs.
        ///
        /// This is what makes a second open cheap. Cold start costs ~7 ms per
        /// EVENT (ADR 0006 M1), and a workspace of any size has a lot of them —
        /// so resuming at a marker rather than re-walking to the beginning is
        /// the difference between minutes and milliseconds. It mirrors the wasm
        /// bridge's bounded `gather_history`, which the native path could not
        /// reach because that module is `#[cfg(feature = "wasm")]`.
        ///
        /// Stops at the first PAGE whose events are all older than the marker
        /// rather than at the first old event: a page is one round-trip either
        /// way, and events within a page are not strictly ordered by
        /// `origin_server_ts` once a server has done any backfill.
        pub async fn load_room_cell_updates_since(
            &self,
            marker_ts: u64,
        ) -> Result<(Vec<CellUpdate>, u64)> {
            let (u, ts, _) = self.load_room_cell_updates_bounded(marker_ts, true).await?;
            Ok((u, ts))
        }

        /// The walk, with the two ways it is allowed to stop early.
        ///
        /// `stop_when_covered` is the one order-based compaction exists for.
        /// Every write refreshes several stale cells, so the newest slice of the
        /// timeline contains a current value for EVERY live cell — walking past
        /// it only re-reads values that have since been superseded. Until now
        /// nothing acted on that: the bumps were written on every edit and the
        /// walk still ran to the beginning of the room, so compaction was pure
        /// write-side cost with no read benefit.
        ///
        /// The stop rule is "a whole page contributed no cell we had not already
        /// seen". A page rather than an event, because events within a page are
        /// not strictly ordered; and cells rather than a count, because the
        /// question is coverage, not distance.
        ///
        /// Pass `false` where the walk must be exhaustive regardless — the
        /// integrity check compares a FULL re-gather against local state, so
        /// letting it stop early would make it agree with itself by
        /// construction.
        pub async fn load_room_cell_updates_bounded(
            &self,
            marker_ts: u64,
            stop_when_covered: bool,
        ) -> Result<(Vec<CellUpdate>, u64, crate::WalkStats)> {
            // Resuming (marker_ts > 0) is a different problem from a cold
            // start, and takes a different page size — see the constants.
            let page = if marker_ts > 0 {
                INCREMENTAL_PAGE_LIMIT
            } else {
                DEFAULT_PAGE_LIMIT
            };
            self.load_room_cell_updates_paged(marker_ts, stop_when_covered, page)
                .await
        }

        /// As above, with the page size exposed.
        ///
        /// Production always uses [`DEFAULT_PAGE_LIMIT`]. This exists because
        /// the coverage stop is page-granular, so exercising it otherwise needs
        /// a room of thousands of events — the rule and the room size are
        /// independent, and only the rule needs a test.
        #[doc(hidden)]
        pub async fn load_room_cell_updates_paged(
            &self,
            marker_ts: u64,
            stop_when_covered: bool,
            page_limit: u32,
        ) -> Result<(Vec<CellUpdate>, u64, crate::WalkStats)> {
            use matrix_sdk::room::MessagesOptions;
            use std::collections::HashSet;

            let room = self.get_room()?;
            // Cold-start key restore: a freshly recovered device has backup
            // *access* (the recovery key opened secure backup) but not the room
            // keys themselves, so the encrypted history paginated below would
            // come back undecryptable and be silently skipped — a new device
            // would see an empty workspace. Pull this room's keys from key
            // backup first. Best-effort: a room may be unencrypted or have no
            // backup yet, and we still proceed with whatever keys we have.
            if let Err(e) = self
                .client
                .encryption()
                .backups()
                .download_room_keys_for_room(room.room_id())
                .await
            {
                debug!("backup key download for {} failed: {e}", room.room_id());
            }

            let mut updates = Vec::new();
            let mut newest_ts: u64 = marker_ts;
            let mut from_token: Option<String> = None;
            let mut seen_cells: HashSet<(String, String, String)> = HashSet::new();
            // Observability, not decoration: every claim about what the bounded
            // walk saves has so far been INFERRED from wall-clock. These counters
            // make the walk say what it actually did.
            let mut pages = 0usize;
            let mut events = 0usize;
            // Every exit from the loop below is a `break` that names itself, so
            // this needs no placeholder value.
            let stop_reason: &'static str;
            let mut last_page_new = 0usize;
            let mut undecryptable = 0usize;
            let mut last_page_sample: Vec<String> = Vec::new();
            loop {
                let mut options = MessagesOptions::backward();
                if let Some(ref token) = from_token {
                    options = options.from(token.as_str());
                }
                options.limit = UInt::from(page_limit);

                let response = room
                    .messages(options)
                    .await
                    .map_err(|e| anyhow::anyhow!("Failed to fetch room history: {e}"))?;
                if response.chunk.is_empty() {
                    stop_reason = "empty page";
                    break;
                }
                pages += 1;
                events += response.chunk.len();
                let mut page_oldest: Option<u64> = None;
                let mut page_new_cells = 0usize;
                // Which cells this page contributed that nothing newer had. On
                // the FINAL page these are the cells nothing ever refreshed —
                // the ones pinning the walk to the start of the room. Naming
                // them is the difference between fixing the cause and guessing
                // at a plausible one, which has cost this feature two wrong
                // suspects already.
                let mut page_first_seen: Vec<String> = Vec::new();
                // A page we could not READ is not a page that told us nothing.
                let mut page_undecryptable = 0usize;
                for ev in &response.chunk {
                    let ts: u64 = ev
                        .raw()
                        .get_field::<u64>("origin_server_ts")
                        .ok()
                        .flatten()
                        .unwrap_or(0);
                    if ts > newest_ts {
                        newest_ts = ts;
                    }
                    if ts > 0 {
                        page_oldest = Some(page_oldest.map_or(ts, |o: u64| o.min(ts)));
                    }
                    // Re-apply everything on a page we are keeping. Cells are
                    // LWW, so replaying one we already have is a no-op — and
                    // skipping by timestamp here would drop events whose stream
                    // order disagrees with their origin_server_ts.
                    if let Ok(json_str) = serde_json::to_string(ev.raw().json()) {
                        if Self::is_undecryptable_event(&json_str) {
                            page_undecryptable += 1;
                            undecryptable += 1;
                        }
                        for received in Self::extract_cell_updates(&json_str) {
                            let u = received.into_update();
                            // Walking backwards, the FIRST time a cell is seen
                            // is its newest value; anything older is superseded
                            // by LWW anyway.
                            if seen_cells.insert((
                                u.table_id.clone(),
                                u.row_id.clone(),
                                u.column_id.clone(),
                            )) {
                                page_new_cells += 1;
                                if page_first_seen.len() < 8 {
                                    page_first_seen.push(format!(
                                        "{}/{}/{}",
                                        u.table_id, u.row_id, u.column_id
                                    ));
                                }
                            }
                            updates.push(u);
                        }
                    }
                }
                last_page_new = page_new_cells;
                last_page_sample = std::mem::take(&mut page_first_seen);

                // Stop only once a whole page trails the marker by more than the
                // reorder grace. The naive rule — stop at the first event older
                // than the marker — assumes stream order and origin_server_ts
                // agree, and under Synapse workers they need not: that is
                // exactly how 8 events were permanently lost in prod on
                // 2026-07-25, because the running marker had already advanced
                // past them so no later run would ever fetch them.
                if crate::backfill_caught_up(marker_ts > 0, page_oldest, marker_ts) {
                    stop_reason = "reached marker";
                    break;
                }
                // Coverage stop: this page told us nothing new, so compaction
                // has already put a current value for every live cell in the
                // slice we have walked. Requires having seen something at all,
                // so an empty first page cannot end the walk immediately.
                // The undecryptable guard is the difference between "compaction
                // already covered everything" and "we could not read this page".
                // Both look like zero new cells; only the first means we are done.
                if stop_when_covered
                    && page_new_cells == 0
                    && page_undecryptable == 0
                    && !seen_cells.is_empty()
                {
                    stop_reason = "covered";
                    break;
                }
                match response.end {
                    Some(token) => from_token = Some(token),
                    None => {
                        stop_reason = "start of room";
                        break;
                    }
                }
            }
            info!(
                "history walk: {events} events over {pages} page(s), {} distinct cells, stopped: {stop_reason}",
                seen_cells.len()
            );
            if last_page_new > 0 {
                info!(
                    "  last page still had {last_page_new} unseen cells, e.g. {}",
                    last_page_sample.join(", ")
                );
            }
            Ok((
                updates,
                newest_ts,
                crate::WalkStats {
                    events,
                    pages,
                    cells: seen_cells.len(),
                    stopped: stop_reason,
                    undecryptable,
                },
            ))
        }
    }

    /// A joined room tagged as a TideWork workspace.
    #[cfg(feature = "matrix-native")]
    #[derive(Debug, Clone)]
    pub struct WorkspaceInfo {
        pub room_id: String,
        pub name: String,
    }

    /// Marks a Matrix room as a TideWork workspace (native send path; the WASM
    /// bridge defines its own equivalent). The presence of the event is the
    /// signal — `workspace` is always `true`.
    #[cfg(feature = "matrix-native")]
    #[derive(Clone, Debug, serde::Deserialize, serde::Serialize, EventContent)]
    #[ruma_event(type = "io.tidework.workspace", kind = State, state_key_type = String)]
    pub struct WorkspaceMarkerEventContent {
        pub workspace: bool,
    }

    /// State event type string tagging a room as a TideWork workspace.
    #[cfg(feature = "matrix-native")]
    const WORKSPACE_STATE_TYPE: &str = "io.tidework.workspace";

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
                "type": "io.tidework.cell.update",
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
                "type": "io.tidework.cell.update",
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
        fn test_extract_cell_updates_from_batch_event() {
            let updates = vec![
                CellUpdate::new("tasks", "r1", "title", json!("A"), 1),
                CellUpdate::new("tasks", "r1", "status", json!("todo"), 2),
                CellUpdate::new("tasks", "r2", "value", json!(3.5), 3), // float survives
            ];
            let content = CellBatchEventContent::from_updates(&updates);
            let event = json!({
                "type": "io.tidework.cell.batch",
                "event_id": "$batch:example.com",
                "origin_server_ts": 1_709_312_400_000u64,
                "content": serde_json::to_value(&content).unwrap(),
                "sender": "@alice:example.com",
            });

            let received = MatrixClient::extract_cell_updates(&event.to_string());
            assert_eq!(received.len(), 3);
            // All cells share the one event's envelope metadata.
            assert!(received
                .iter()
                .all(|r| r.event_id.as_str() == "$batch:example.com"));
            assert_eq!(received[0].update.value, json!("A"));
            assert_eq!(received[1].update.column_id, "status");
            assert_eq!(received[2].update.value, json!(3.5));
            // origin_server_ts is attached as the LWW tiebreaker on each cell.
            assert_eq!(
                received[2].clone().into_update().server_timestamp,
                Some(1_709_312_400_000)
            );
        }

        #[test]
        fn test_extract_cell_updates_handles_single_event() {
            let event = json!({
                "type": "io.tidework.cell.update",
                "event_id": "$one:example.com",
                "origin_server_ts": 100,
                "content": {
                    "version": 1, "table_id": "t", "row_id": "r",
                    "column_id": "c", "value": "\"v\"", "timestamp": 5
                },
            });
            let received = MatrixClient::extract_cell_updates(&event.to_string());
            assert_eq!(received.len(), 1);
            assert_eq!(received[0].update.value, json!("v"));
        }

        #[test]
        fn test_extract_cell_update_singular_ignores_batch() {
            let content = CellBatchEventContent::from_updates(&[CellUpdate::new(
                "t",
                "r",
                "c",
                json!("v"),
                1,
            )]);
            let event = json!({
                "type": "io.tidework.cell.batch",
                "event_id": "$b:example.com",
                "origin_server_ts": 1,
                "content": serde_json::to_value(&content).unwrap(),
            });
            // The singular extractor only understands single events.
            assert!(MatrixClient::extract_cell_update(&event.to_string()).is_none());
            // The plural extractor reads the batch.
            assert_eq!(
                MatrixClient::extract_cell_updates(&event.to_string()).len(),
                1
            );
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
