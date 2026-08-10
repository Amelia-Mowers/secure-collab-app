//! Integration test: the history walk stops once compaction has covered every
//! cell, instead of running to the beginning of the room.
//!
//! This exists because the bump machinery shipped long before anything acted on
//! it: cells were refreshed on every write, and the walk still read the whole
//! room. Compaction was pure write-side cost. A wall-clock benchmark can't tell
//! that apart from a walk that merely got lucky on a small room, so the
//! assertions here are on what the walk DID — events read, and why it stopped.
//!
//! Run with: cargo test --features matrix-native -- --ignored
//!
//! Gated on matrix-native, not plain matrix: the bounded loader lives on the
//! native client (the browser has its own copy in bridge_matrix).

#![cfg(feature = "matrix-native")]

mod harness;

use harness::{setup_workspace, TestHarness};
use serde_json::json;
use tables_over_matrix::CellUpdate;

/// A room with far more events than live cells: the walk should read the newest
/// slice, find every cell in it, and stop.
#[tokio::test]
#[ignore]
async fn test_walk_stops_once_cells_are_covered() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, _room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();
    let alice = &clients[0];

    // A small table, rewritten many times over. Real compaction bumps aren't
    // needed to prove the rule — repeatedly rewriting the same cells produces
    // the same shape a bumped room has, which is the point: recent events
    // already carry a current value for everything live.
    const CELLS: usize = 6;
    const ROUNDS: usize = 40;
    let mut ts = 1_000u64;
    for round in 0..ROUNDS {
        for cell in 0..CELLS {
            ts += 1;
            alice
                .send_cell_update(&CellUpdate::new(
                    "tasks",
                    format!("row{cell}"),
                    "title",
                    json!(format!("round {round}")),
                    ts,
                ))
                .await
                .unwrap();
        }
    }
    let total_events = CELLS * ROUNDS;

    // Cold start: no snapshot, so marker_ts is 0 and the walk starts from the
    // newest end of the room.
    //
    // Small pages here ONLY. The stop is page-granular, so at the production
    // page size (1000) a room this size is a single request and the walk ends
    // by running out of room rather than by detecting coverage — which is
    // correct, and also unable to tell a working rule from a broken one. The
    // rule and the page size are independent; this test is about the rule.
    const PAGE: u32 = 20;
    let (updates, _newest, stats) = alice
        .load_room_cell_updates_paged(0, true, PAGE)
        .await
        .unwrap();

    assert_eq!(
        stats.cells, CELLS,
        "every live cell must be resolved — a bounded walk that loses data is \
         not a bounded walk, it is a bug"
    );
    assert_eq!(
        stats.stopped, "covered",
        "expected the coverage stop to end the walk, got {:?}",
        stats.stopped
    );
    assert!(
        stats.events < total_events,
        "the walk read {} of {total_events} events — it did not stop early at all",
        stats.events
    );

    // The values that survive must be the newest ones; stopping early is only
    // sound because anything deeper has already lost LWW.
    let result = tables_over_matrix::materialize_from_timeline(updates);
    let table = result.tables.get("tasks").unwrap();
    for cell in 0..CELLS {
        assert_eq!(
            table.get_value(&format!("row{cell}"), "title"),
            Some(&json!(format!("round {}", ROUNDS - 1))),
            "cell {cell} did not end on its newest value"
        );
    }
}

/// The opt-out has to keep working: the integrity check audits a full re-gather
/// against local state, so a walk that stopped early would agree with itself by
/// construction and the audit would prove nothing.
#[tokio::test]
#[ignore]
async fn test_exhaustive_walk_reads_everything() {
    let harness = TestHarness::new().await.unwrap();
    let (clients, _room_id) = setup_workspace(&harness, &["alice"]).await.unwrap();
    let alice = &clients[0];

    const CELLS: usize = 4;
    const ROUNDS: usize = 20;
    let mut ts = 1_000u64;
    for round in 0..ROUNDS {
        for cell in 0..CELLS {
            ts += 1;
            alice
                .send_cell_update(&CellUpdate::new(
                    "tasks",
                    format!("row{cell}"),
                    "title",
                    json!(format!("round {round}")),
                    ts,
                ))
                .await
                .unwrap();
        }
    }

    let (_updates, _newest, stats) = alice
        .load_room_cell_updates_paged(0, false, 20)
        .await
        .unwrap();

    assert_ne!(
        stats.stopped, "covered",
        "the exhaustive walk must never take the coverage shortcut"
    );
    assert!(
        stats.events >= CELLS * ROUNDS,
        "exhaustive walk read only {} of {} events",
        stats.events,
        CELLS * ROUNDS
    );
}

// The third rule the coverage stop depends on — that an UNREADABLE page must
// not count as a covered one — is tested in `crate::coverage_reached` rather
// than here.
//
// It was attempted here first and could not be built honestly. Reaching a page
// that is unreadable RATHER than covered needs a device holding room keys for
// part of a room and not the rest, with the unreadable part NEWER than the
// readable part. Joining part-way gives the opposite order: the walk correctly
// stops on the readable pages before it ever reaches the older unreadable ones,
// so the fixture produced `undecryptable: 0, stopped: "covered"` and proved
// nothing. Forcing it would mean rotating a Megolm session out from under a
// joined member — a great deal of crypto to arrange for a three-term predicate.
