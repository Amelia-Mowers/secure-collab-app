//! Integration tests for app-core Workspace with Matrix connectivity.
//!
//! These tests exercise the same operations exposed by bridge_matrix.rs
//! but run natively against a real Conduit homeserver.
//!
//! Run with:
//!   cargo test -p app-core --no-default-features --features matrix-native \
//!     --test workspace_matrix -- --ignored --nocapture

#![cfg(feature = "matrix")]

mod harness;

use harness::{connected_workspace, setup_workspace, TestHarness};
use serde_json::json;
use tables_over_matrix::CellUpdate;

use app_core::schema::{ColumnDefinition, ColumnType, TableDefinition};
use app_core::views::{KanbanConfig, ViewConfig, ViewType};

/// Helper: send a single CellUpdate through the workspace's MatrixClient.
/// Drops the immutable borrow before returning so the caller can mutate `ws` again.
async fn send_update(ws: &app_core::Workspace, update: &CellUpdate) {
    ws.matrix_client().unwrap().send_cell_update(update).await.unwrap();
}

/// Helper: send a batch of CellUpdates.
async fn send_updates(ws: &app_core::Workspace, updates: &[CellUpdate]) {
    ws.matrix_client().unwrap().send_cell_updates(updates).await.unwrap();
}

// ─── Realistic scenarios ────────────────────────────────────────────

#[tokio::test]
#[ignore]
async fn test_workspace_create_table_and_send_updates() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    let mut ws = connected_workspace(&room_id, clients.into_iter().next().unwrap());

    // Create a table
    let def = TableDefinition::new("tasks", "Tasks")
        .with_column(ColumnDefinition::new("title", "Title", ColumnType::Text))
        .with_column(ColumnDefinition::new("status", "Status", ColumnType::Select));

    let updates = ws.create_table(def).unwrap();
    assert!(!updates.is_empty(), "create_table should produce schema updates");

    // Send the schema updates to Matrix
    send_updates(&ws, &updates).await;

    // Now add some data
    ws.update_cell("tasks", "t1", "title", json!("Design homepage")).unwrap();
    ws.update_cell("tasks", "t1", "status", json!("todo")).unwrap();

    let ts = ws.next_timestamp_pub();
    let update = CellUpdate::new("tasks", "t1", "title", json!("Design homepage"), ts);
    send_update(&ws, &update).await;

    // Verify local state
    let table = ws.get_table("tasks").unwrap();
    assert_eq!(table.get_value("t1", "title"), Some(&json!("Design homepage")));
    assert_eq!(table.get_value("t1", "status"), Some(&json!("todo")));

    eprintln!("[PASS] workspace_create_table_and_send_updates");
}

#[tokio::test]
#[ignore]
async fn test_two_workspaces_sync_via_matrix() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice", "bob"]).await.unwrap();

    let mut clients_iter = clients.into_iter();
    let alice_client = clients_iter.next().unwrap();
    let bob_client = clients_iter.next().unwrap();

    let mut alice_ws = connected_workspace(&room_id, alice_client);
    let mut bob_ws = connected_workspace(&room_id, bob_client);

    // Alice creates a table and sends updates
    let def = TableDefinition::new("notes", "Notes")
        .with_column(ColumnDefinition::new("body", "Body", ColumnType::Text));

    let schema_updates = alice_ws.create_table(def.clone()).unwrap();
    send_updates(&alice_ws, &schema_updates).await;

    // Alice adds a note
    alice_ws.update_cell("notes", "n1", "body", json!("Hello from Alice")).unwrap();
    let ts = alice_ws.next_timestamp_pub();
    let update = CellUpdate::new("notes", "n1", "body", json!("Hello from Alice"), ts);
    send_update(&alice_ws, &update).await;

    // Wait for propagation
    harness.wait_for_sync().await;

    // Bob creates the table locally and applies Alice's update
    bob_ws.create_table(def).unwrap();
    bob_ws.apply_update(update).unwrap();

    let bob_table = bob_ws.get_table("notes").unwrap();
    assert_eq!(
        bob_table.get_value("n1", "body"),
        Some(&json!("Hello from Alice")),
        "Bob should see Alice's update"
    );

    eprintln!("[PASS] two_workspaces_sync_via_matrix");
}

#[tokio::test]
#[ignore]
async fn test_workspace_multiple_tables_and_views() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    let mut ws = connected_workspace(&room_id, clients.into_iter().next().unwrap());

    // Create two tables
    let tasks_def = TableDefinition::new("tasks", "Tasks")
        .with_column(ColumnDefinition::new("title", "Title", ColumnType::Text))
        .with_column(ColumnDefinition::new("status", "Status", ColumnType::Select))
        .with_column(ColumnDefinition::new("assignee", "Assignee", ColumnType::Text));

    let projects_def = TableDefinition::new("projects", "Projects")
        .with_column(ColumnDefinition::new("name", "Name", ColumnType::Text))
        .with_column(ColumnDefinition::new("budget", "Budget", ColumnType::Number));

    let task_updates = ws.create_table(tasks_def).unwrap();
    let proj_updates = ws.create_table(projects_def).unwrap();

    send_updates(&ws, &task_updates).await;
    send_updates(&ws, &proj_updates).await;

    // Add data to both tables
    ws.update_cell("tasks", "t1", "title", json!("Fix bug")).unwrap();
    ws.update_cell("tasks", "t1", "status", json!("In Progress")).unwrap();
    ws.update_cell("tasks", "t1", "assignee", json!("Alice")).unwrap();

    ws.update_cell("projects", "p1", "name", json!("Website Redesign")).unwrap();
    ws.update_cell("projects", "p1", "budget", json!(50000)).unwrap();

    // Create a kanban view for tasks
    let kanban_config = KanbanConfig {
        group_by_column: "status".to_string(),
        title_column: "title".to_string(),
        display_columns: vec![],
        column_options: vec!["Todo".into(), "In Progress".into(), "Done".into()],
    };
    let view_config = ViewConfig::new("board-1", "Sprint Board", "tasks", ViewType::Kanban)
        .with_kanban_config(kanban_config);

    let view_updates = ws.create_view(view_config).unwrap();
    send_updates(&ws, &view_updates).await;

    // Verify tables
    let tables = ws.list_tables();
    assert_eq!(tables.len(), 2);

    // Verify view
    let view = ws.get_view("board-1").unwrap();
    assert_eq!(view.name, "Sprint Board");
    assert_eq!(view.table_id, "tasks");
    assert!(view.kanban_config.is_some());

    // Verify views per table
    let task_views = ws.list_views_for_table("tasks");
    assert_eq!(task_views, vec!["board-1"]);
    let proj_views = ws.list_views_for_table("projects");
    assert!(proj_views.is_empty());

    eprintln!("[PASS] workspace_multiple_tables_and_views");
}

#[tokio::test]
#[ignore]
async fn test_workspace_add_column_after_creation() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    let mut ws = connected_workspace(&room_id, clients.into_iter().next().unwrap());

    // Create a table with one column
    let def = TableDefinition::new("items", "Items")
        .with_column(ColumnDefinition::new("name", "Name", ColumnType::Text));

    let updates = ws.create_table(def).unwrap();
    send_updates(&ws, &updates).await;

    // Add data
    ws.update_cell("items", "i1", "name", json!("Widget A")).unwrap();

    // Add a new column
    let new_col = ColumnDefinition::new("price", "Price", ColumnType::Number);
    let col_updates = ws.add_column("items", new_col).unwrap();
    send_updates(&ws, &col_updates).await;

    // Set value in the new column
    ws.update_cell("items", "i1", "price", json!(29.99)).unwrap();

    // Verify schema has both columns
    let schema = ws.get_table_schema("items").unwrap();
    assert_eq!(schema.columns.len(), 2);
    assert!(schema.columns.contains_key("name"));
    assert!(schema.columns.contains_key("price"));

    // Verify data
    let table = ws.get_table("items").unwrap();
    assert_eq!(table.get_value("i1", "name"), Some(&json!("Widget A")));
    assert_eq!(table.get_value("i1", "price"), Some(&json!(29.99)));

    eprintln!("[PASS] workspace_add_column_after_creation");
}

#[tokio::test]
#[ignore]
async fn test_workspace_delete_row_and_verify() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    let mut ws = connected_workspace(&room_id, clients.into_iter().next().unwrap());

    let def = TableDefinition::new("users", "Users")
        .with_column(ColumnDefinition::new("name", "Name", ColumnType::Text));
    ws.create_table(def).unwrap();

    // Add 3 rows
    ws.update_cell("users", "u1", "name", json!("Alice")).unwrap();
    ws.update_cell("users", "u2", "name", json!("Bob")).unwrap();
    ws.update_cell("users", "u3", "name", json!("Charlie")).unwrap();

    assert_eq!(ws.get_table("users").unwrap().rows().len(), 3);

    // Delete middle row
    ws.delete_row("users", "u2").unwrap();

    let table = ws.get_table("users").unwrap();
    assert_eq!(table.rows().len(), 2);
    assert!(table.get_value("u2", "name").is_none());
    assert_eq!(table.get_value("u1", "name"), Some(&json!("Alice")));
    assert_eq!(table.get_value("u3", "name"), Some(&json!("Charlie")));

    eprintln!("[PASS] workspace_delete_row_and_verify");
}

#[tokio::test]
#[ignore]
async fn test_workspace_invite_and_member_listing() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice", "bob"]).await.unwrap();

    // Both clients are already in the room (setup_workspace handles invite+join).
    let alice = &clients[0];
    alice.sync_once().await.unwrap();

    let room_id_parsed: matrix_sdk::ruma::OwnedRoomId =
        room_id.as_str().try_into().unwrap();
    let room = alice.inner().get_room(&room_id_parsed).unwrap();

    // The room should have at least 2 members
    let members = room
        .members(matrix_sdk::RoomMemberships::ACTIVE)
        .await
        .unwrap();
    assert!(
        members.len() >= 2,
        "Expected at least 2 active members, got {}",
        members.len()
    );

    let user_ids: Vec<String> = members.iter().map(|m| m.user_id().to_string()).collect();
    assert!(user_ids.iter().any(|id| id.contains("alice")));
    assert!(user_ids.iter().any(|id| id.contains("bob")));

    eprintln!("[PASS] workspace_invite_and_member_listing");
}

// ─── Edge cases ─────────────────────────────────────────────────────

#[tokio::test]
#[ignore]
async fn test_edge_case_empty_string_values() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    let mut ws = connected_workspace(&room_id, clients.into_iter().next().unwrap());

    let def = TableDefinition::new("edge", "Edge Cases")
        .with_column(ColumnDefinition::new("text", "Text", ColumnType::Text));
    ws.create_table(def).unwrap();

    // Empty string
    ws.update_cell("edge", "r1", "text", json!("")).unwrap();
    let ts = ws.next_timestamp_pub();
    let update = CellUpdate::new("edge", "r1", "text", json!(""), ts);
    send_update(&ws, &update).await;

    let table = ws.get_table("edge").unwrap();
    assert_eq!(table.get_value("r1", "text"), Some(&json!("")));

    eprintln!("[PASS] edge_case_empty_string_values");
}

#[tokio::test]
#[ignore]
async fn test_edge_case_unicode_and_special_chars() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    let mut ws = connected_workspace(&room_id, clients.into_iter().next().unwrap());

    let def = TableDefinition::new("unicode", "Unicode Table")
        .with_column(ColumnDefinition::new("text", "Text", ColumnType::Text));
    ws.create_table(def).unwrap();

    // Unicode characters
    let unicode_val = json!("Hello \u{4e16}\u{754c} \u{1f30d}"); // Hello 世界 🌍
    ws.update_cell("unicode", "r1", "text", unicode_val.clone()).unwrap();
    let ts = ws.next_timestamp_pub();
    send_update(&ws, &CellUpdate::new("unicode", "r1", "text", unicode_val.clone(), ts)).await;

    assert_eq!(ws.get_table("unicode").unwrap().get_value("r1", "text"), Some(&unicode_val));

    // Newlines and tabs
    let special = json!("line1\nline2\ttab");
    ws.update_cell("unicode", "r2", "text", special.clone()).unwrap();
    let ts = ws.next_timestamp_pub();
    send_update(&ws, &CellUpdate::new("unicode", "r2", "text", special.clone(), ts)).await;

    assert_eq!(ws.get_table("unicode").unwrap().get_value("r2", "text"), Some(&special));

    // Quotes and backslashes
    let escaped = json!(r#"He said "hello" \ world"#);
    ws.update_cell("unicode", "r3", "text", escaped.clone()).unwrap();
    let ts = ws.next_timestamp_pub();
    send_update(&ws, &CellUpdate::new("unicode", "r3", "text", escaped.clone(), ts)).await;

    assert_eq!(ws.get_table("unicode").unwrap().get_value("r3", "text"), Some(&escaped));

    eprintln!("[PASS] edge_case_unicode_and_special_chars");
}

#[tokio::test]
#[ignore]
async fn test_edge_case_large_payload() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    let mut ws = connected_workspace(&room_id, clients.into_iter().next().unwrap());

    let def = TableDefinition::new("large", "Large Data")
        .with_column(ColumnDefinition::new("data", "Data", ColumnType::Text));
    ws.create_table(def).unwrap();

    // 10KB string
    let large_string = "x".repeat(10_000);
    ws.update_cell("large", "r1", "data", json!(large_string.clone())).unwrap();

    let ts = ws.next_timestamp_pub();
    let update = CellUpdate::new("large", "r1", "data", json!(large_string.clone()), ts);
    send_update(&ws, &update).await;

    let table = ws.get_table("large").unwrap();
    let stored = table.get_value("r1", "data").unwrap().as_str().unwrap();
    assert_eq!(stored.len(), 10_000);

    eprintln!("[PASS] edge_case_large_payload");
}

#[tokio::test]
#[ignore]
async fn test_edge_case_numeric_extremes() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    let mut ws = connected_workspace(&room_id, clients.into_iter().next().unwrap());

    let def = TableDefinition::new("nums", "Numbers")
        .with_column(ColumnDefinition::new("value", "Value", ColumnType::Number));
    ws.create_table(def).unwrap();

    // Zero
    ws.update_cell("nums", "r1", "value", json!(0)).unwrap();
    let ts = ws.next_timestamp_pub();
    send_update(&ws, &CellUpdate::new("nums", "r1", "value", json!(0), ts)).await;

    // Negative
    ws.update_cell("nums", "r2", "value", json!(-999999)).unwrap();
    let ts = ws.next_timestamp_pub();
    send_update(&ws, &CellUpdate::new("nums", "r2", "value", json!(-999999), ts)).await;

    // Float (now safe to send — value is string-encoded on the wire)
    ws.update_cell("nums", "r3", "value", json!(3.14159265358979)).unwrap();
    let ts = ws.next_timestamp_pub();
    send_update(&ws, &CellUpdate::new("nums", "r3", "value", json!(3.14159265358979), ts)).await;

    // Large integer (JS MAX_SAFE_INTEGER)
    ws.update_cell("nums", "r4", "value", json!(9007199254740991_i64)).unwrap();
    let ts = ws.next_timestamp_pub();
    send_update(&ws, &CellUpdate::new("nums", "r4", "value", json!(9007199254740991_i64), ts)).await;

    let table = ws.get_table("nums").unwrap();
    assert_eq!(table.get_value("r1", "value"), Some(&json!(0)));
    assert_eq!(table.get_value("r2", "value"), Some(&json!(-999999)));
    assert_eq!(table.get_value("r3", "value"), Some(&json!(3.14159265358979)));
    assert_eq!(table.get_value("r4", "value"), Some(&json!(9007199254740991_i64)));

    eprintln!("[PASS] edge_case_numeric_extremes");
}

#[tokio::test]
#[ignore]
async fn test_edge_case_null_and_boolean_values() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    let mut ws = connected_workspace(&room_id, clients.into_iter().next().unwrap());

    let def = TableDefinition::new("mixed", "Mixed Types")
        .with_column(ColumnDefinition::new("flag", "Flag", ColumnType::Boolean))
        .with_column(ColumnDefinition::new("data", "Data", ColumnType::Text));
    ws.create_table(def).unwrap();

    // Boolean true
    ws.update_cell("mixed", "r1", "flag", json!(true)).unwrap();
    let ts = ws.next_timestamp_pub();
    send_update(&ws, &CellUpdate::new("mixed", "r1", "flag", json!(true), ts)).await;

    // Boolean false
    ws.update_cell("mixed", "r2", "flag", json!(false)).unwrap();
    let ts = ws.next_timestamp_pub();
    send_update(&ws, &CellUpdate::new("mixed", "r2", "flag", json!(false), ts)).await;

    // Null value
    ws.update_cell("mixed", "r3", "data", json!(null)).unwrap();
    let ts = ws.next_timestamp_pub();
    send_update(&ws, &CellUpdate::new("mixed", "r3", "data", json!(null), ts)).await;

    let table = ws.get_table("mixed").unwrap();
    assert_eq!(table.get_value("r1", "flag"), Some(&json!(true)));
    assert_eq!(table.get_value("r2", "flag"), Some(&json!(false)));
    assert_eq!(table.get_value("r3", "data"), Some(&json!(null)));

    eprintln!("[PASS] edge_case_null_and_boolean_values");
}

#[tokio::test]
#[ignore]
async fn test_edge_case_nonexistent_table_operations() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    let mut ws = connected_workspace(&room_id, clients.into_iter().next().unwrap());

    // Operations on nonexistent table should fail
    assert!(ws.update_cell("ghost", "r1", "col", json!("val")).is_err());
    assert!(ws.delete_row("ghost", "r1").is_err());
    assert!(ws.get_table("ghost").is_none());
    assert!(ws.get_table_rows("ghost").is_err());
    assert!(ws.get_table_schema("ghost").is_none());

    // View on nonexistent table
    let view_config = ViewConfig::new("v1", "Ghost View", "ghost", ViewType::Kanban);
    assert!(ws.create_view(view_config).is_err());

    // Nonexistent view
    assert!(ws.get_view("nonexistent").is_none());

    eprintln!("[PASS] edge_case_nonexistent_table_operations");
}

#[tokio::test]
#[ignore]
async fn test_edge_case_rapid_updates_same_cell() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    let mut ws = connected_workspace(&room_id, clients.into_iter().next().unwrap());

    let def = TableDefinition::new("counter", "Counter")
        .with_column(ColumnDefinition::new("value", "Value", ColumnType::Number));
    ws.create_table(def).unwrap();

    // Send 20 rapid updates to the same cell
    for i in 0..20 {
        ws.update_cell("counter", "c1", "value", json!(i)).unwrap();
        let ts = ws.next_timestamp_pub();
        let update = CellUpdate::new("counter", "c1", "value", json!(i), ts);
        send_update(&ws, &update).await;
    }

    // Final value should be 19 (last write wins)
    let table = ws.get_table("counter").unwrap();
    assert_eq!(table.get_value("c1", "value"), Some(&json!(19)));

    // Should still only have 1 row
    assert_eq!(table.rows().len(), 1);

    eprintln!("[PASS] edge_case_rapid_updates_same_cell");
}

#[tokio::test]
#[ignore]
async fn test_edge_case_many_rows() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    let mut ws = connected_workspace(&room_id, clients.into_iter().next().unwrap());

    let def = TableDefinition::new("bulk", "Bulk Data")
        .with_column(ColumnDefinition::new("name", "Name", ColumnType::Text));
    ws.create_table(def).unwrap();

    // Add 100 rows
    for i in 0..100 {
        let row_id = format!("row-{}", i);
        let value = json!(format!("Item {}", i));
        ws.update_cell("bulk", &row_id, "name", value).unwrap();
    }

    let table = ws.get_table("bulk").unwrap();
    assert_eq!(table.rows().len(), 100);

    // Verify first and last
    assert_eq!(table.get_value("row-0", "name"), Some(&json!("Item 0")));
    assert_eq!(table.get_value("row-99", "name"), Some(&json!("Item 99")));

    // Delete half
    for i in 0..50 {
        ws.delete_row("bulk", &format!("row-{}", i)).unwrap();
    }

    let table = ws.get_table("bulk").unwrap();
    assert_eq!(table.rows().len(), 50);
    assert!(table.get_value("row-0", "name").is_none());
    assert_eq!(table.get_value("row-50", "name"), Some(&json!("Item 50")));

    eprintln!("[PASS] edge_case_many_rows");
}

#[tokio::test]
#[ignore]
async fn test_edge_case_concurrent_table_operations() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice", "bob"]).await.unwrap();

    let mut clients_iter = clients.into_iter();
    let alice_client = clients_iter.next().unwrap();
    let bob_client = clients_iter.next().unwrap();

    let mut alice_ws = connected_workspace(&room_id, alice_client);
    let mut bob_ws = connected_workspace(&room_id, bob_client);

    // Both create the same table locally
    let def = TableDefinition::new("shared", "Shared Table")
        .with_column(ColumnDefinition::new("text", "Text", ColumnType::Text));

    alice_ws.create_table(def.clone()).unwrap();
    bob_ws.create_table(def).unwrap();

    // Alice writes to cell A
    alice_ws.update_cell("shared", "r1", "text", json!("Alice's data")).unwrap();
    let ts = alice_ws.next_timestamp_pub();
    let alice_update = CellUpdate::new("shared", "r1", "text", json!("Alice's data"), ts);
    send_update(&alice_ws, &alice_update).await;

    // Bob writes to cell B
    bob_ws.update_cell("shared", "r2", "text", json!("Bob's data")).unwrap();
    let ts = bob_ws.next_timestamp_pub();
    let bob_update = CellUpdate::new("shared", "r2", "text", json!("Bob's data"), ts);
    send_update(&bob_ws, &bob_update).await;

    // Each applies the other's update
    alice_ws.apply_update(bob_update).unwrap();
    bob_ws.apply_update(alice_update).unwrap();

    // Both should converge on the same state
    let alice_table = alice_ws.get_table("shared").unwrap();
    let bob_table = bob_ws.get_table("shared").unwrap();

    assert_eq!(alice_table.rows().len(), 2);
    assert_eq!(bob_table.rows().len(), 2);

    assert_eq!(alice_table.get_value("r1", "text"), Some(&json!("Alice's data")));
    assert_eq!(alice_table.get_value("r2", "text"), Some(&json!("Bob's data")));
    assert_eq!(bob_table.get_value("r1", "text"), Some(&json!("Alice's data")));
    assert_eq!(bob_table.get_value("r2", "text"), Some(&json!("Bob's data")));

    eprintln!("[PASS] edge_case_concurrent_table_operations");
}

#[tokio::test]
#[ignore]
async fn test_edge_case_lww_conflict_resolution() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice", "bob"]).await.unwrap();

    let mut clients_iter = clients.into_iter();
    let alice_client = clients_iter.next().unwrap();
    let bob_client = clients_iter.next().unwrap();

    let mut alice_ws = connected_workspace(&room_id, alice_client);
    let mut bob_ws = connected_workspace(&room_id, bob_client);

    // Both create the table
    let def = TableDefinition::new("conflict", "Conflict Table")
        .with_column(ColumnDefinition::new("value", "Value", ColumnType::Text));
    alice_ws.create_table(def.clone()).unwrap();
    bob_ws.create_table(def).unwrap();

    // Both write to the SAME cell with different timestamps
    // Alice writes with lower timestamp
    let alice_update = CellUpdate::new("conflict", "r1", "value", json!("Alice wins?"), 100);
    alice_ws.apply_update(alice_update.clone()).unwrap();
    send_update(&alice_ws, &alice_update).await;

    // Bob writes with higher timestamp (should win LWW)
    let bob_update = CellUpdate::new("conflict", "r1", "value", json!("Bob wins!"), 200);
    bob_ws.apply_update(bob_update.clone()).unwrap();
    send_update(&bob_ws, &bob_update).await;

    // Apply each other's updates
    alice_ws.apply_update(bob_update).unwrap();
    bob_ws.apply_update(alice_update).unwrap();

    // Both should resolve to Bob's value (higher timestamp wins)
    assert_eq!(
        alice_ws.get_table("conflict").unwrap().get_value("r1", "value"),
        Some(&json!("Bob wins!"))
    );
    assert_eq!(
        bob_ws.get_table("conflict").unwrap().get_value("r1", "value"),
        Some(&json!("Bob wins!"))
    );

    eprintln!("[PASS] edge_case_lww_conflict_resolution");
}

#[tokio::test]
#[ignore]
async fn test_edge_case_json_object_as_cell_value() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    let mut ws = connected_workspace(&room_id, clients.into_iter().next().unwrap());

    let def = TableDefinition::new("rich", "Rich Data")
        .with_column(ColumnDefinition::new("metadata", "Metadata", ColumnType::Text));
    ws.create_table(def).unwrap();

    // Store a JSON object as a cell value
    let complex = json!({
        "tags": ["urgent", "bug"],
        "priority": 1,
        "nested": {"key": "value"},
    });
    ws.update_cell("rich", "r1", "metadata", complex.clone()).unwrap();

    let ts = ws.next_timestamp_pub();
    let update = CellUpdate::new("rich", "r1", "metadata", complex.clone(), ts);
    send_update(&ws, &update).await;

    let table = ws.get_table("rich").unwrap();
    assert_eq!(table.get_value("r1", "metadata"), Some(&complex));

    eprintln!("[PASS] edge_case_json_object_as_cell_value");
}
