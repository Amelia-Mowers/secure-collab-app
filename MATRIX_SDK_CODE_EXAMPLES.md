# matrix-sdk 0.14.0 - Practical Code Examples for WASM

## 1. Basic Login and Sync Setup

```rust
use matrix_sdk::Client;
use matrix_sdk::config::SyncSettings;
use url::Url;

// Create client
let homeserver = Url::parse("https://matrix.example.com")?;
let client = Client::new(homeserver).await?;

// Login
client
    .matrix_auth()
    .login_username("username", "password")
    .send()
    .await?;

// Simple continuous sync (runs forever until error)
client.sync(SyncSettings::default()).await?;
```

---

## 2. Sync with Event Handlers

```rust
use ruma::events::room::message::OriginalSyncRoomMessageEvent;

// Add event handler
client.add_event_handler(|ev: OriginalSyncRoomMessageEvent| async move {
    println!("Message from {}: {}", ev.sender, ev.content.body());
});

// Start sync loop - events will be delivered to handlers
client.sync(SyncSettings::default()).await?;
```

---

## 3. Sync with Callback (Get Full Responses)

```rust
use matrix_sdk::LoopCtrl;
use matrix_sdk::config::SyncSettings;

let sync_settings = SyncSettings::default();

client
    .sync_with_callback(sync_settings, |response| async move {
        // Process full sync response
        println!("Synced! Got {} joined rooms", response.rooms.joined.len());
        
        for (room_id, room) in response.rooms.joined {
            println!("  Room {}: {} events", room_id, room.timeline.events.len());
        }
        
        LoopCtrl::Continue  // Keep syncing
    })
    .await?;
```

---

## 4. Sync with Error Handling Callback

```rust
use matrix_sdk::LoopCtrl;

client
    .sync_with_result_callback(SyncSettings::default(), |result| async move {
        match result {
            Ok(response) => {
                println!("Sync OK: {} rooms", response.rooms.joined.len());
                Ok(LoopCtrl::Continue)
            }
            Err(e) => {
                eprintln!("Sync error: {}", e);
                // Decide: continue trying or break
                Ok(LoopCtrl::Continue)  // Retry
                // Or: Err(e) to stop entirely
            }
        }
    })
    .await?;
```

---

## 5. Single Sync (One-shot)

```rust
use matrix_sdk::config::SyncSettings;

let sync_response = client.sync_once(SyncSettings::default()).await?;
println!("Got next_batch: {}", sync_response.next_batch());

// Can be called repeatedly for manual sync control
for i in 0..5 {
    let response = client.sync_once(SyncSettings::default()).await?;
    println!("Sync {}: {}", i, response.next_batch());
}
```

---

## 6. Stream-based Sync (Advanced)

```rust
use futures_util::stream::StreamExt;

let mut sync_stream = client.sync_stream(SyncSettings::default()).await;

while let Some(result) = sync_stream.next().await {
    match result {
        Ok(response) => {
            println!("Got sync: {}", response.next_batch());
        }
        Err(e) => {
            eprintln!("Sync error: {}", e);
            break;
        }
    }
}
```

---

## 7. List and Access Rooms

```rust
// Get all joined rooms
let joined = client.joined_rooms();
println!("Joined rooms: {}", joined.len());

// Get specific room
if let Some(room) = joined.first() {
    println!("First room: {}", room.room_id());
    
    // Get room name
    if let Some(name) = room.name() {
        println!("  Name: {}", name);
    }
    
    // Get room members
    let members = room.members(RoomMemberships::ACTIVE).await?;
    println!("  Members: {}", members.len());
}

// Reactive room stream for UI updates
let (rooms, stream) = client.rooms_stream();
println!("Initial rooms: {}", rooms.len());

// Stream yields updates when rooms change
tokio::spawn(async move {
    let mut stream = stream;
    while let Some(diffs) = stream.next().await {
        println!("Rooms changed!");
    }
});
```

---

## 8. Create a Room

```rust
use ruma::api::client::room::create_room::v3::Request;
use ruma::events::room::RoomType;

// Create a group chat
let request = Request {
    visibility: ruma::api::client::room::Visibility::Private,
    room_alias_id: None,
    name: Some("My Chat Room".to_string()),
    topic: Some("Discussion about things".to_string()),
    invite: vec![],
    is_direct: false,
    room_version: None,
    initial_state: vec![],
    preset: None,
    power_level_content_override: None,
};

let room = client.create_room(request).await?;
println!("Created room: {}", room.room_id());
```

---

## 9. Create a Direct Message (DM) Room

```rust
use ruma::api::client::room::create_room::v3::Request;

let invite_user = UserId::parse("@alice:example.com")?;

let request = Request {
    visibility: ruma::api::client::room::Visibility::Private,
    is_direct: true,  // Mark as DM
    invite: vec![invite_user.clone()],
    // ... other fields with defaults
    ..Default::default()
};

let dm_room = client.create_room(request).await?;
println!("Created DM with: {}", invite_user);
```

---

## 10. Send a Message

```rust
use ruma::events::room::message::RoomMessageEventContent;

let room = client.joined_rooms().into_iter().next()?;

// Simple text message
let content = RoomMessageEventContent::text_plain("Hello, world!");
room.send(content).await?;

// Message with transaction ID
use ruma::TransactionId;
let txn_id = TransactionId::new();
let content = RoomMessageEventContent::text_plain("Hello!");
room.send(content)
    .with_transaction_id(txn_id)
    .await?;

// Formatted message
use ruma::events::room::message::{FormattedBody, MessageType};
let formatted = RoomMessageEventContent::new(
    MessageType::Text(
        ruma::events::room::message::TextMessageEventContent {
            body: "**Bold** text".to_string(),
            formatted_body: Some(FormattedBody::html(
                "<strong>Bold</strong> text"
            )),
        }
    )
);
room.send(formatted).await?;
```

---

## 11. Get Room Members

```rust
use ruma::membership::RoomMemberships;

// Full member list (syncs with server first)
let members = room.members(RoomMemberships::ACTIVE).await?;
for member in members {
    println!("  {}: {}", member.name(), member.user_id());
}

// Cached members (might be incomplete due to lazy loading)
let cached = room.members_no_sync(RoomMemberships::ACTIVE).await?;
println!("Cached members: {}", cached.len());
```

---

## 12. Invite a User

```rust
use ruma::UserId;

let target_user = UserId::parse("@alice:example.com")?;

// Invite by user ID
room.invite_user_by_id(&target_user).await?;
println!("Invited {}", target_user);

// Invite by 3PID (email, phone)
use ruma::api::client::membership::Invite3pid;
let invite = Invite3pid {
    address: "alice@example.com".to_string(),
    medium: "email".to_string(),
    id_server: "id.example.com".to_string(),
};

room.invite_user_by_3pid(invite).await?;
```

---

## 13. Send State Event

```rust
use ruma::events::room::topic::RoomTopicEventContent;

let content = RoomTopicEventContent::new("New room topic".to_string());
room.send_state_event(content).await?;
```

---

## 14. WASM-Specific: No Media Download

```rust
// This will NOT compile in WASM target
#[cfg(not(target_family = "wasm"))]
{
    let media_source = /* ... */;
    let data = client.media().get_file(&media_source).await?;
    // File operations not available in WASM
}

// For WASM, you must use the homeserver URL directly
#[cfg(target_family = "wasm")]
{
    let media_source = /* ... */;
    // Use: client.media().get_media_url(&media_source)
    // Then fetch directly from browser
}
```

---

## 15. Event Handler with Context

```rust
use ruma::events::room::message::OriginalSyncRoomMessageEvent;

// Add shared context
#[derive(Clone)]
struct AppState {
    user_id: String,
}

let state = AppState {
    user_id: "me".to_string(),
};

client.add_handler_context(state.clone());

client.add_event_handler(
    |ev: OriginalSyncRoomMessageEvent, ctx: AppState| async move {
        if ev.sender.to_string() != ctx.user_id {
            println!("Message from {}: {}", ev.sender, ev.content.body());
        }
    }
);
```

---

## 16. Manual Sync Loop with Cancellation

```rust
use tokio::task;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

let should_stop = Arc::new(AtomicBool::new(false));
let stop_clone = should_stop.clone();

let sync_task = task::spawn(async move {
    while !stop_clone.load(Ordering::Relaxed) {
        match client.sync_once(SyncSettings::default()).await {
            Ok(response) => {
                println!("Synced: {}", response.next_batch());
            }
            Err(e) => {
                eprintln!("Sync error: {}", e);
                break;
            }
        }
        
        // Small delay to avoid busy-waiting
        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    }
});

// Do other work...

// Stop sync
should_stop.store(true, Ordering::Relaxed);
sync_task.await?;
```

---

## 17. Get Client Information

```rust
use matrix_sdk::ruma::api::client::account::whoami;

// Get your user ID and device ID
let whoami_response = client.whoami().await?;
println!("You are: {}", whoami_response.user_id);

// Get authentication manager
let auth = client.matrix_auth();
// Use for login, logout, etc.

// Get account manager
let account = client.account();
// Use for account operations

// Get media manager
let media = client.media();
// Use for media operations (non-WASM only)
```

---

## 18. Sync Settings Options

```rust
use matrix_sdk::config::SyncSettings;
use std::time::Duration;

let sync_settings = SyncSettings::default()
    .timeout(Duration::from_secs(30))  // Long-poll timeout
    .full_state(true);                  // Get full state on first sync

// Use with sync method
client.sync(sync_settings).await?;

// Or recreate for subsequent syncs
let next_settings = SyncSettings::default()
    .timeout(Duration::from_secs(30));
```

---

## 19. Error Handling Patterns

```rust
use matrix_sdk::Error;

// Comprehensive error handling
match result {
    Ok(()) => println!("Success"),
    Err(Error::Http(http_error)) => {
        eprintln!("HTTP error: {}", http_error);
    }
    Err(Error::InvalidUrl(_)) => {
        eprintln!("Invalid homeserver URL");
    }
    Err(Error::Serde(_)) => {
        eprintln!("Serialization error");
    }
    Err(e) => {
        eprintln!("Other error: {}", e);
    }
}
```

---

## 20. WASM-Specific: Event Handler Without Send

```rust
// In WASM, handlers don't need Send bounds
// This works in WASM but would need Send on native

use std::rc::Rc;
use std::cell::RefCell;

let counter = Rc::new(RefCell::new(0));
let count_clone = counter.clone();

client.add_event_handler(
    move |_ev: OriginalSyncRoomMessageEvent| {
        let count = count_clone.clone();
        async move {
            *count.borrow_mut() += 1;
        }
    }
);

// Later: check counter value
println!("Events processed: {}", *counter.borrow());
```

Note: This pattern uses `Rc<RefCell<T>>` which is NOT Send. It works in WASM but 
would not work in native Rust where handlers need Send.

