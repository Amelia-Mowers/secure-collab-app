# matrix-sdk 0.14.0 API Guide for WASM Builds

## Overview
The matrix-sdk 0.14.0 has WASM-specific considerations documented throughout the codebase using `#[cfg(target_family = "wasm")]` and `#[cfg(not(target_family = "wasm"))]` attributes.

---

## Client API

### Authentication & Setup

#### `client.matrix_auth()` -> `MatrixAuth`
**Purpose:** Returns the authentication manager for the client.

```rust
pub fn matrix_auth(&self) -> MatrixAuth {
    MatrixAuth::new(self.clone())
}
```

**Usage Example:**
```rust
client.matrix_auth().login_username(&username, &password).send().await?;
```

---

### Sync Methods

#### 1. `client.sync_once(sync_settings)` - Single Sync
```rust
pub async fn sync_once(
    &self,
    sync_settings: crate::config::SyncSettings,
) -> Result<SyncResponse>
```

**Purpose:** Performs a single synchronization with the homeserver. Returns the `SyncResponse` containing updates.

**Details:**
- Takes `SyncSettings` to configure timeout, filter, full_state, and set_presence
- Returns raw `SyncResponse` (not wrapped in error handling loop)
- Handles crypto outgoing requests before and after sync

---

#### 2. `client.sync(sync_settings)` - Continuous Sync Loop
```rust
pub async fn sync(&self, sync_settings: crate::config::SyncSettings) -> Result<(), Error>
```

**Purpose:** Repeatedly synchronize until an error occurs. Returns `Err(Error)` on failure.

**Details:**
- Wrapper around `sync_with_callback` with default empty callback
- Only returns on error
- Use with `add_event_handler()` to react to individual events
- Settings only apply to first sync call

**Example:**
```rust
client.matrix_auth().login_username(&username, &password).send().await?;

client.add_event_handler(|ev: OriginalSyncRoomMessageEvent| async move {
    println!("Received event {}: {:?}", ev.sender, ev.content);
});

client.sync(SyncSettings::default()).await?;
```

---

#### 3. `client.sync_with_callback(sync_settings, callback)` - Callback-based Sync
```rust
pub async fn sync_with_callback<C>(
    &self,
    sync_settings: crate::config::SyncSettings,
    callback: impl Fn(SyncResponse) -> C,
) -> Result<(), Error>
where
    C: Future<Output = LoopCtrl>,
```

**Purpose:** Sync loop that calls a callback with each full sync response. Callback returns `LoopCtrl`.

**Returns:**
- `Ok(())` if callback returns `LoopCtrl::Break`
- `Err(Error)` if network error occurs

**Example:**
```rust
let (tx, rx) = channel(100);

client
    .sync_with_callback(sync_settings, |response| async move {
        for (room_id, room) in response.rooms.joined {
            for event in room.timeline.events {
                channel.send(event).await.unwrap();
            }
        }
        LoopCtrl::Continue  // Continue syncing
    })
    .await;
```

---

#### 4. `client.sync_with_result_callback(sync_settings, callback)` - Error Handling Callback
```rust
pub async fn sync_with_result_callback<C>(
    &self,
    sync_settings: crate::config::SyncSettings,
    callback: impl Fn(Result<SyncResponse, Error>) -> C,
) -> Result<(), Error>
where
    C: Future<Output = Result<LoopCtrl, Error>>,
```

**Purpose:** Sync loop where callback handles both success and error results.

**Callback Returns:**
- `Ok(LoopCtrl::Continue)` → continue syncing
- `Ok(LoopCtrl::Break)` → stop syncing, return `Ok(())`
- `Err(Error)` → stop syncing, return the error

**Note:** Lower-level retries are handled before callback receives result.

---

#### 5. `client.sync_stream(sync_settings)` - Stream-based Sync
```rust
pub async fn sync_stream(
    &self,
    mut sync_settings: crate::config::SyncSettings,
) -> impl Stream<Item = Result<SyncResponse>> + '_
```

**Purpose:** Returns a Stream yielding sync results. Internally used by callback methods.

**Details:**
- Returns an async stream (uses `async_stream::stream!`)
- Yields `Result<SyncResponse>` items
- Automatically loops and manages sync tokens
- Can be used with streams API: `.next().await`

---

### Room Management

#### `client.rooms()` -> `Vec<Room>`
```rust
pub fn rooms(&self) -> Vec<Room>
```
Returns all rooms (joined, invited, left).

#### `client.rooms_filtered(filter)` -> `Vec<Room>`
```rust
pub fn rooms_filtered(&self, filter: RoomStateFilter) -> Vec<Room>
```
Returns rooms filtered by state (JOINED, INVITED, LEFT).

#### `client.rooms_stream()` -> `(Vector<Room>, Stream)`
```rust
pub fn rooms_stream(&self) -> (Vector<Room>, impl Stream<Item = Vec<VectorDiff<Room>>> + '_)
```
Returns initial rooms + stream of updates. Useful for reactive UIs.

#### `client.joined_rooms()` -> `Vec<Room>`
```rust
pub fn joined_rooms(&self) -> Vec<Room>
```
Shorthand for `rooms_filtered(RoomStateFilter::JOINED)`.

#### `client.invited_rooms()` -> `Vec<Room>`
```rust
pub fn invited_rooms(&self) -> Vec<Room>
```

#### `client.left_rooms()` -> `Vec<Room>`
```rust
pub fn left_rooms(&self) -> Vec<Room>
```

#### `client.create_room(request)` -> `Result<Room>`
```rust
pub async fn create_room(&self, request: create_room::v3::Request) -> Result<Room>
```

**Details:**
- Takes `matrix_sdk::ruma::api::client::room::create_room::v3::Request`
- Handles marking as DM if appropriate
- Returns joined room

**Example:**
```rust
use ruma::api::client::room::create_room::v3::Request;

let request = Request {
    invite: vec![user_id.clone()],
    is_direct: true,
    // ... other fields
};

let room = client.create_room(request).await?;
```

---

## Room API

### Sending Messages

#### `room.send(content)` -> `SendMessageLikeEvent`
```rust
pub fn send(&self, content: impl MessageLikeEventContent) -> SendMessageLikeEvent<'_>
```

**Purpose:** Returns a builder for sending a message-like event. **Not** awaited directly.

**Builder Methods:**
- `.with_transaction_id(txn_id)` - Set transaction ID (generated if not set)
- `.with_request_config(config)` - Set network request config

**Usage:**
```rust
use ruma::events::room::message::RoomMessageEventContent;

let content = RoomMessageEventContent::text_plain("Hello!");
room.send(content).await?;

// Or with transaction ID
room.send(content)
    .with_transaction_id(txn_id)
    .await?;
```

**Implementation:** `SendMessageLikeEvent` implements `IntoFuture`, so can be awaited.

---

### Membership Operations

#### `room.members(memberships)` -> `Result<Vec<RoomMember>>`
```rust
pub async fn members(&self, memberships: RoomMemberships) -> Result<Vec<RoomMember>>
```

**Purpose:** Get members with optional sync. Syncs members first to ensure full list.

**Parameters:**
- `RoomMemberships` - flags like JOINED, INVITED, etc.

---

#### `room.members_no_sync(memberships)` -> `Result<Vec<RoomMember>>`
```rust
pub async fn members_no_sync(&self, memberships: RoomMemberships) -> Result<Vec<RoomMember>>
```

**Purpose:** Get cached members without syncing. May be incomplete due to lazy loading.

---

#### `room.invite_user_by_id(user_id)` -> `Result<()>`
```rust
pub async fn invite_user_by_id(&self, user_id: &UserId) -> Result<()>
```

**Purpose:** Invite user by Matrix user ID.

**Details:**
- Shares room history if E2EE enabled (configurable)
- Forces member list reload to prevent UTDs (Unverified Transitions)

**Example:**
```rust
let user_id = UserId::parse("@user:example.com")?;
room.invite_user_by_id(&user_id).await?;
```

---

#### `room.invite_user_by_3pid(invite_id)` -> `Result<()>`
```rust
pub async fn invite_user_by_3pid(&self, invite_id: Invite3pid) -> Result<()>
```

**Purpose:** Invite user by third-party ID (email, phone, etc.).

---

### Sending Events

#### `room.send_raw(request)` -> `SendRawMessageLikeEvent`
```rust
pub fn send_raw<'a>(
    &self,
    request: impl Into<RawMessageLikeEventRequest<'a>>,
) -> SendRawMessageLikeEvent<'a>
```

---

#### `room.send_state_event(content)` -> `SendStateEvent`
```rust
pub fn send_state_event<'a>(
    &self,
    content: impl StateEventContent,
) -> SendStateEvent<'a>
```

---

#### `room.send_attachment()` -> `SendAttachment`
```rust
pub fn send_attachment<'a>(
    &self,
    body: impl Into<String>,
    config: AttachmentConfig,
) -> SendAttachment<'a>
```

---

## WASM-Specific Considerations

### 1. Event Handler Type Differences
**File:** `src/event_handler/mod.rs`

For WASM vs non-WASM:

```rust
#[cfg(not(target_family = "wasm"))]
type EventHandlerFut = Pin<Box<dyn Future<Output = ()> + Send>>;
#[cfg(target_family = "wasm")]
type EventHandlerFut = Pin<Box<dyn Future<Output = ()>>>;

#[cfg(not(target_family = "wasm"))]
type EventHandlerFn = dyn Fn(EventHandlerData<'_>) -> EventHandlerFut + Send + Sync;
#[cfg(target_family = "wasm")]
type EventHandlerFn = dyn Fn(EventHandlerData<'_>) -> EventHandlerFut;
```

**Key Point:** WASM handlers do NOT require `Send + Sync` bounds because WASM is single-threaded.

---

### 2. AnyMap Type Differences
```rust
#[cfg(not(target_family = "wasm"))]
type AnyMap = anymap2::Map<dyn CloneAnySendSync + Send + Sync>;
#[cfg(target_family = "wasm")]
type AnyMap = anymap2::Map<dyn CloneAny>;
```

**Key Point:** WASM uses `CloneAny` (no Send/Sync), native uses `CloneAnySendSync`.

---

### 3. SendOutsideWasm Trait Bound
**File:** `src/room/mod.rs` line 49

```rust
use matrix_sdk_base::{
    // ...
    ComposerDraft, EncryptionState, RoomInfoNotableUpdateReasons, RoomMemberships, 
    SendOutsideWasm, // <-- WASM-specific trait
    // ...
};
```

**Purpose:** Marks futures that must be `Send` only on non-WASM targets.

**Example Usage:**
```rust
pub fn get_timeline_event_context(&self, event_id: &EventId)
    -> impl Future<Output = Result<TimelineEvent, Error>> + SendOutsideWasm;
```

---

### 4. Media Operations
**File:** `src/media.rs`

```rust
#[cfg(not(target_family = "wasm"))]
pub async fn get_file(&self, media_source: &MediaSource) -> HttpResult<Vec<u8>>

#[cfg(not(target_family = "wasm"))]
pub async fn download_thumbnail(&self, ...) -> Result<Vec<u8>>
```

**Key Point:** Media file operations (download, thumbnail) are NOT available in WASM builds.

---

### 5. Event Dispatcher
**File:** `src/event_handler/mod.rs` line 744

Event dispatcher uses platform-specific task spawning:
- Non-WASM: Uses `tokio::spawn` (can be Send)
- WASM: Uses local task spawning (single-threaded)

---

## Configuration

### SyncSettings
```rust
pub struct SyncSettings {
    pub token: SyncToken,           // ReusePrevious | Specific(token) | NoToken
    pub timeout: Option<Duration>,  // Long-poll timeout
    pub filter: Option<Filter>,
    pub full_state: bool,
    pub set_presence: PresenceState,
}
```

---

## Summary: Key Differences for WASM

| Aspect | Non-WASM | WASM |
|--------|----------|------|
| Event Handlers | `Send + Sync` required | No Send/Sync |
| Task Spawning | `tokio::spawn` | Local spawning |
| AnyMap Type | `CloneAnySendSync + Send + Sync` | `CloneAny` |
| Media Operations | Available | Not compiled |
| Futures Bounds | Require `Send` | No Send required |

---

## Async Methods Reference

All these methods are async and should be awaited:

**Client Methods:**
- `sync_once(sync_settings)` → `SyncResponse`
- `sync(sync_settings)` → `()`
- `sync_with_callback(sync_settings, cb)` → `()`
- `sync_with_result_callback(sync_settings, cb)` → `()`
- `create_room(request)` → `Room`

**Room Methods:**
- `members(memberships)` → `Vec<RoomMember>`
- `members_no_sync(memberships)` → `Vec<RoomMember>`
- `invite_user_by_id(user_id)` → `()`
- `invite_user_by_3pid(invite_id)` → `()`
- `send(...).await` → Message response
- `send_state_event(...).await` → State response

---

## Callback Loop Control

```rust
pub enum LoopCtrl {
    Continue,  // Keep syncing
    Break,     // Stop syncing
}
```

Used in `sync_with_callback` and `sync_with_result_callback`.

