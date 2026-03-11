# matrix-sdk 0.14.0 - Technical Deep Dive

## Source Code Analysis

### Client Sync Architecture

**File:** `/src/client/mod.rs`

The sync system uses a multi-layered approach:

```
sync()
  └─> sync_with_callback(settings, |_| Continue)
       └─> sync_with_result_callback(settings, error_aware_cb)
            └─> sync_stream(settings)
                 └─> async_stream::stream! { loop { sync_once() } }
```

#### How sync_stream Works

```rust
pub async fn sync_stream(
    &self,
    mut sync_settings: SyncSettings,
) -> impl Stream<Item = Result<SyncResponse>> + '_ {
    // Uses async_stream::stream! macro
    // Yields Result<SyncResponse> infinitely
    // Automatically manages sync tokens
    // Handles delays between syncs
}
```

Key behaviors:
1. First sync uses configured timeout
2. Subsequent syncs reuse token (unless NoToken)
3. Built-in delay prevents busy-waiting
4. Settings only apply to first sync

#### sync_once() Implementation Details

```rust
pub async fn sync_once(
    &self,
    sync_settings: crate::config::SyncSettings,
) -> Result<SyncResponse> {
    // 1. Send outgoing crypto requests (if E2EE enabled)
    // 2. Build sync request with token handling:
    //    - SyncToken::ReusePrevious -> Get stored token
    //    - SyncToken::Specific(t) -> Use provided token
    //    - SyncToken::NoToken -> No token (full sync)
    // 3. Adjust request timeout (base 30s + configured timeout)
    // 4. Send request: self.send(request).with_request_config(...)
    // 5. Process sync response with self.process_sync()
    // 6. Send outgoing crypto requests again
    // 7. Notify sync_beat for observers
    // 8. Return SyncResponse with next_batch token
}
```

---

## Room API Architecture

**File:** `/src/room/mod.rs`

### Sending Messages

The `send()` method returns a builder (not awaitable directly):

```rust
pub fn send(&self, content: impl MessageLikeEventContent) -> SendMessageLikeEvent<'_> {
    SendMessageLikeEvent::new(self, content)
}

// SendMessageLikeEvent implements IntoFuture:
impl<'a> IntoFuture for SendMessageLikeEvent<'a> {
    type Output = Result<send_message_event::v3::Response>;
    // Allows: room.send(content).await
}
```

Builder pattern allows:
- Setting transaction ID before sending
- Configuring request behavior
- Chaining operations

### Invite Mechanism

```rust
pub async fn invite_user_by_id(&self, user_id: &UserId) -> Result<()> {
    // 1. Share room history if E2EE enabled
    //    (config: enable_share_history_on_invite)
    // 2. Build InvitationRecipient::UserId
    // 3. Create invite_user::v3::Request
    // 4. Send to server: self.client.send(request)
    // 5. Force member reload: mark_members_missing()
    //    (Prevents "Unable To Decrypt" issues)
    // 6. Return Ok(())
}
```

Why mark_members_missing()?
- Ensures fresh member list on next sync
- Prevents sending events before membership arrives
- Avoids UTD (Unable To Decrypt) errors with E2EE

### Member Loading

Two strategies:

```rust
// Strategy 1: Full sync (recommended)
pub async fn members(&self, memberships: RoomMemberships) -> Result<Vec<RoomMember>> {
    self.sync_members().await?;  // Fetch from server if not lazy-loaded
    self.members_no_sync(memberships).await  // Return cached
}

// Strategy 2: Cached only (fast but incomplete)
pub async fn members_no_sync(&self, memberships: RoomMemberships) -> Result<Vec<RoomMember>> {
    // Returns what's in local store
    // May be incomplete due to lazy loading optimization
}
```

Lazy loading: Servers don't send all member events (expensive). Only fetch on demand.

---

## WASM-Specific Implementation Details

### 1. Event Handler Type System

**File:** `/src/event_handler/mod.rs`

```rust
// Non-WASM: Requires Send for thread safety
#[cfg(not(target_family = "wasm"))]
type EventHandlerFut = Pin<Box<dyn Future<Output = ()> + Send>>;
#[cfg(not(target_family = "wasm"))]
type EventHandlerFn = dyn Fn(EventHandlerData<'_>) -> EventHandlerFut + Send + Sync;

// WASM: No Send/Sync (single-threaded)
#[cfg(target_family = "wasm")]
type EventHandlerFut = Pin<Box<dyn Future<Output = ()>>>;
#[cfg(target_family = "wasm")]
type EventHandlerFn = dyn Fn(EventHandlerData<'_>) -> EventHandlerFut;
```

Impact on user code:
- WASM: Can use `Rc<RefCell<_>>`, closures don't need `move` sometimes
- Non-WASM: Must use `Arc<Mutex<_>>`, closures need `move`, must be `Send + Sync`

### 2. AnyMap Type Differences

```rust
#[cfg(not(target_family = "wasm"))]
type AnyMap = anymap2::Map<dyn CloneAnySendSync + Send + Sync>;

#[cfg(target_family = "wasm")]
type AnyMap = anymap2::Map<dyn CloneAny>;
```

Used for: Handler context storage (add_handler_context)

### 3. SendOutsideWasm Trait

**From:** `matrix_sdk_base`

```rust
pub trait SendOutsideWasm: Send {}
impl<T: Send> SendOutsideWasm for T {}

// In WASM:
pub trait SendOutsideWasm {}
impl<T> SendOutsideWasm for T {}
```

Usage: Marks futures that require Send on native but not WASM:

```rust
impl Room {
    pub fn get_timeline_event_context(
        &self,
        event_id: &EventId,
    ) -> impl Future<Output = Result<TimelineEvent, Error>> + SendOutsideWasm;
}
```

### 4. Media Operations

**File:** `/src/media.rs`

All these methods are `#[cfg(not(target_family = "wasm"))]`:

```rust
pub async fn get_file(&self, media_source: &MediaSource) -> HttpResult<Vec<u8>>
pub async fn download_thumbnail(&self, ...) -> Result<Vec<u8>>
pub async fn get_media_content(&self, ...) -> HttpResult<MediaFileHandle>
```

Reason: WASM can't write arbitrary files to disk. Instead:

```rust
// WASM has only this:
pub fn get_media_url(&self, media_source: &MediaSource) -> Option<String>

// Then use browser fetch:
let url = client.media().get_media_url(media_source)?;
let response = web_sys::window().fetch_with_str(&url).await?;
```

### 5. Task Spawning

Event dispatcher adapts to platform:

```rust
#[cfg(not(target_family = "wasm"))]
{
    tokio::spawn(future)  // Multi-threaded
}

#[cfg(target_family = "wasm")]
{
    // Uses local task executor (single-threaded)
    spawn_local(future)
}
```

---

## Sync Response Structure

```rust
pub struct SyncResponse {
    next_batch: String,  // New sync token for next sync
    rooms: Rooms,
    presence: Presence,
    account_data: AccountData,
    device_lists: DeviceLists,
    device_one_time_keys_count: BTreeMap<DeviceKeyAlgorithm, UInt>,
    to_device: ToDevice,
}

pub struct Rooms {
    pub joined: BTreeMap<OwnedRoomId, JoinedRoom>,
    pub invited: BTreeMap<OwnedRoomId, InvitedRoom>,
    pub left: BTreeMap<OwnedRoomId, LeftRoom>,
}

pub struct JoinedRoom {
    pub account_data: RoomAccountData,
    pub ephemeral: RoomEphemeral,
    pub state: RoomState,
    pub timeline: Timeline,
    pub summary: Option<RoomSummary>,
    pub unread_notifications: RoomUnreadNotifications,
    pub unread_thread_notifications: BTreeMap<OwnedEventId, RoomUnreadNotifications>,
}

pub struct Timeline {
    pub limited: bool,
    pub prev_batch: Option<String>,
    pub events: Vec<TimelineEvent>,
}
```

### Processing Flow

```
SyncResponse comes in
  └─> process_sync()
       ├─> Update client state
       ├─> Decrypt E2EE events (if enabled)
       ├─> Process timeline events
       ├─> Update room state
       ├─> Fire event handlers
       └─> Update room observable streams
```

---

## Configuration

### SyncSettings

```rust
pub struct SyncSettings {
    pub token: SyncToken,
    pub timeout: Option<Duration>,
    pub filter: Option<Filter>,
    pub full_state: bool,
    pub set_presence: PresenceState,
    pub ignore_timeout_on_first_sync: bool,
}

pub enum SyncToken {
    ReusePrevious,        // Use stored token
    Specific(String),     // Use provided token
    NoToken,              // Empty sync (full state)
}

pub enum PresenceState {
    Online,
    Offline,
    Unavailable,
}
```

### Default Behavior

```rust
impl Default for SyncSettings {
    fn default() -> Self {
        Self {
            token: SyncToken::ReusePrevious,
            timeout: None,
            filter: None,
            full_state: false,
            set_presence: PresenceState::Online,
            ignore_timeout_on_first_sync: false,
        }
    }
}
```

---

## Crypto Integration

The SDK integrates E2EE (end-to-end encryption):

```rust
// Before sync_once():
if let Err(e) = self.send_outgoing_requests().await {
    error!("Error sending E2EE requests");
}

// During sync:
// - Decrypt events
// - Process key shares
// - Update device lists

// After sync_once():
if let Err(e) = self.send_outgoing_requests().await {
    error!("Error sending E2EE requests");
}
```

For WASM:
- Uses wasm-bindgen for crypto
- No platform-specific code paths
- Same API as native

---

## Room State Management

Rooms are kept in sync via:

```rust
pub fn rooms_stream(&self) -> (Vector<Room>, impl Stream<Item = Vec<VectorDiff<Room>>> + '_)
```

Returns:
1. Initial `Vector<Room>` (data structure that supports indexing)
2. Stream of `VectorDiff<Room>` updates:
   - `VectorDiff::Append(Room)`
   - `VectorDiff::Remove { index }`
   - `VectorDiff::Set { index, value }`
   - `VectorDiff::PushFront { value }`
   - `VectorDiff::PushBack { value }`

Useful for: Reactive UIs that need incremental updates

---

## Error Handling

```rust
pub enum Error {
    Http(HttpError),
    InvalidUrl(InvalidUrlError),
    Serde(SerdeError),
    CryptoStore(CryptoStoreError),
    StateStore(StateStoreError),
    Io(IoError),
    // ... more variants
}
```

Sync errors are retried automatically with backoff before reaching callback.

---

## Testing Considerations

### Non-WASM Tests

```rust
#[cfg(all(test, not(target_family = "wasm")))]
mod tests {
    // ... test code
}
```

Examples:
- `/src/paginators/room.rs:412`
- `/src/room_directory_search.rs:216`

### Why?

Some tests use:
- Tokio multi-threaded runtime
- File I/O
- Process spawning
- Not feasible in WASM environment

---

## Performance Notes

1. **Lazy Loading:** Members not loaded until requested
2. **Long Polling:** Timeout keeps connection alive while idle
3. **Incremental Updates:** Use `rooms_stream()` for reactive UIs
4. **Transaction IDs:** Prevent duplicates on retries
5. **Sync Tokens:** Track position in event history
6. **Crypto Batching:** E2EE requests bundled with sync

---

## Key Imports for Usage

```rust
use matrix_sdk::{
    Client,                          // Main client
    config::SyncSettings,            // Sync configuration
    LoopCtrl,                        // Loop control in callbacks
    ruma::{
        UserId,                      // User IDs
        RoomId,                      // Room IDs
        events::room::message::RoomMessageEventContent,  // Messages
        api::client::room::create_room::v3::Request,    // Room creation
    },
};

// For WASM compatibility checks:
#[cfg(target_family = "wasm")]
use wasm_bindgen_futures::spawn_local;

#[cfg(not(target_family = "wasm"))]
use tokio::spawn;
```

