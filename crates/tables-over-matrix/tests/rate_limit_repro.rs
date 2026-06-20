//! Reproduction: creating a table from a template stalls / persists only some
//! columns in PRODUCTION, but not in tests.
//!
//! Root cause is a Conduit-vs-Synapse rate-limit divergence:
//! - The Playwright e2e runs against **Conduit**, which barely rate-limits.
//! - The Rust integration harness runs **Synapse** but cranks `rc_message` to
//!   1000/1000, so it never exercises real limits either.
//! - **Production Synapse sets no `rc_message` override → Synapse defaults**
//!   (`per_second: 0.2`, `burst_count: 10`). Creating a table from a 5-column
//!   template emits ~30 individual `io.tidework.cell.update` events (one per
//!   cell). After the first 10 (the burst) the homeserver throttles to ~1 event
//!   / 5s, so the create takes ~100s ("stall"); if the user reloads mid-flush,
//!   only the cells that landed persist ("half the fields").
//!
//! This test reproduces that with a Synapse configured to production's default
//! `rc_message`. Run with:
//!   cargo test -p tables-over-matrix --no-default-features --features matrix-native \
//!     --test rate_limit_repro -- --ignored --nocapture

#![cfg(feature = "matrix")]

mod harness;

use harness::{setup_workspace, TestHarness};
use serde_json::json;
use std::time::{Duration, Instant};
use tables_over_matrix::{CellUpdate, MatrixClient};

/// The per-cell updates a 5-column template create emits today: a table-name
/// cell, then name/type/required/order per column (+options/default for the two
/// selects) — ~30 events, all sent in a tight loop.
fn template_create_updates() -> Vec<CellUpdate> {
    let cols = ["title", "status", "assignee", "due_date", "priority"];
    let mut updates = vec![CellUpdate::new(
        "_tables",
        "proj",
        "name",
        json!("Project tracker"),
        1,
    )];
    let mut ts = 2u64;
    for (i, col) in cols.iter().enumerate() {
        let row = format!("proj.{col}");
        for field in ["table_id", "column_id", "name", "type", "required", "order"] {
            updates.push(CellUpdate::new("_schema", &row, field, json!("x"), ts));
            ts += 1;
        }
        // status + priority are selects → options (+ status default).
        if i == 1 || i == 4 {
            updates.push(CellUpdate::new(
                "_schema",
                &row,
                "options",
                json!(["a", "b"]),
                ts,
            ));
            ts += 1;
        }
    }
    updates
}

#[tokio::test]
#[ignore]
async fn repro_template_create_burst_throttled_by_prod_rate_limits() {
    let updates = template_create_updates();
    let n = updates.len();
    eprintln!("[repro] template create emits {n} per-cell events");

    // Synapse with production's default rc_message (0.2/s, burst 10).
    let harness = TestHarness::new_with_prod_message_rate_limit()
        .await
        .unwrap();
    let (clients, _room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    // Send the whole create the per-cell way (as the bridge used to). Cap the
    // wait at 25s: unthrottled this completes in <1s, but under prod limits only
    // ~15 of the 33 events get through in 25s, so the timeout firing is itself
    // proof of throttling (and keeps this out of the ~120s full-burst territory
    // in CI).
    let started = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(25),
        clients[0].send_cell_updates(&updates),
    )
    .await;
    let elapsed = started.elapsed();

    match &result {
        Err(_) => eprintln!("[repro] send timed out after {elapsed:?} (still throttled)"),
        Ok(Ok(ids)) => eprintln!("[repro] all {} events sent in {elapsed:?}", ids.len()),
        Ok(Err(e)) => eprintln!("[repro] send failed after {elapsed:?}: {e}"),
    }

    // The divergence: on the relaxed harness this same burst completes in well
    // under a second. Under production defaults it must be throttled hard — it
    // either fails / times out, or takes far longer than a non-throttled burst
    // ever would. (burst 10 + ~20 more at ~0.2/s ⇒ tens of seconds minimum.)
    let throttled = result.is_err()           // timed out
        || result.as_ref().unwrap().is_err()  // SDK gave up retrying a 429
        || elapsed > Duration::from_secs(10); // forced into the slow refill

    assert!(
        throttled,
        "expected production rc_message defaults to throttle a {n}-event create burst, \
         but it completed in {elapsed:?} — the divergence may have changed"
    );
}

/// The fix: sending the same create as a SINGLE batch event stays within the
/// burst, so it is not throttled — and every cell still round-trips through the
/// real homeserver timeline.
#[tokio::test]
#[ignore]
async fn batched_template_create_is_fast_under_prod_rate_limits() {
    let updates = template_create_updates();
    let n = updates.len();

    let harness = TestHarness::new_with_prod_message_rate_limit()
        .await
        .unwrap();
    let (clients, _room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();

    let started = Instant::now();
    clients[0].send_cell_batch(&updates).await.unwrap();
    let elapsed = started.elapsed();
    eprintln!("[fix] batched {n}-cell create sent in {elapsed:?}");

    // One event ⇒ within the burst ⇒ no throttling. (Unbatched took ~120s.)
    assert!(
        elapsed < Duration::from_secs(10),
        "batched create should not be throttled (took {elapsed:?})"
    );

    // Every cell round-trips: read the batch event back off the timeline.
    clients[0].sync_once().await.unwrap();
    let room = clients[0].get_room().unwrap();
    let response = room
        .messages(matrix_sdk::room::MessagesOptions::backward())
        .await
        .unwrap();
    let mut received = 0usize;
    for event in &response.chunk {
        if let Ok(json_str) = serde_json::to_string(event.raw().json()) {
            received += MatrixClient::extract_cell_updates(&json_str).len();
        }
    }
    assert_eq!(
        received, n,
        "all {n} cells should arrive in the single batch event"
    );
}
