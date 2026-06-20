//! Cold-start materialization capacity benchmark.
//!
//! Cold start fetches a room's timeline and replays every cell-update event
//! through the materialization engine. This measures how that engine scales —
//! the dominant client-side cost of opening a workspace — so we know roughly how
//! many cells/events a workspace can hold before cold start gets slow, and where
//! the knee is. Pure CPU, no homeserver (so it's deterministic and safe to run
//! anywhere); the network/throughput dimensions are measured separately (see
//! `rate_limit_repro.rs`).
//!
//! Run with:
//!   cargo test -p tables-over-matrix --test perf_coldstart -- --ignored --nocapture
//!
//! Reported numbers are machine-dependent; treat them as relative + for spotting
//! the degradation knee, not absolute SLAs.

use std::time::Instant;
use tables_over_matrix::{materialize_from_timeline, CellUpdate};

/// Build `cells` distinct cell updates laid out as a `cols`-wide table
/// (≈ `cells / cols` rows), newest-first as Matrix backward-pagination yields.
fn distinct_cells(cells: usize, cols: usize) -> Vec<CellUpdate> {
    let mut v = Vec::with_capacity(cells);
    for i in 0..cells {
        let row = i / cols;
        let col = i % cols;
        v.push(CellUpdate::new(
            "t",
            format!("row{row}"),
            format!("col{col}"),
            serde_json::json!(i),
            (i + 1) as u64,
        ));
    }
    v.reverse(); // newest-first
    v
}

#[test]
#[ignore]
fn perf_coldstart_scaling() {
    println!("\ncold-start materialization — distinct cells (10 cols/row):");
    println!("  {:>10}  {:>10}  {:>12}", "cells", "time", "events/sec");
    for &cells in &[1_000usize, 10_000, 50_000, 100_000, 200_000] {
        let events = distinct_cells(cells, 10);
        let n = events.len();
        let t = Instant::now();
        let result = materialize_from_timeline(events);
        let dt = t.elapsed();
        // Sanity: every distinct cell materialized.
        let total: usize = result.tables.values().map(|tbl| tbl.cell_count()).sum();
        assert_eq!(total, cells, "all cells should materialize");
        let per_sec = (n as f64 / dt.as_secs_f64()) as u64;
        println!("  {cells:>10}  {dt:>10.2?}  {per_sec:>12}");
    }

    // Churn: the same logical cells rewritten many times bloats the timeline.
    // Cold start pays for *events scanned*, so this shows why the lookback must
    // be bounded by bumping (the engine still resolves to the live cell count).
    println!("\ncold-start with churn (5,000 cells, each rewritten N times):");
    println!(
        "  {:>6}  {:>10}  {:>10}  {:>10}",
        "rewrites", "events", "time", "cells"
    );
    for &k in &[1usize, 5, 10, 20] {
        let base = 5_000usize;
        let mut events = Vec::with_capacity(base * k);
        let mut ts = 1u64;
        for rewrite in 0..k {
            for i in 0..base {
                events.push(CellUpdate::new(
                    "t",
                    format!("row{}", i / 10),
                    format!("col{}", i % 10),
                    serde_json::json!(rewrite),
                    ts,
                ));
                ts += 1;
            }
        }
        events.reverse();
        let n = events.len();
        let t = Instant::now();
        let result = materialize_from_timeline(events);
        let dt = t.elapsed();
        let total: usize = result.tables.values().map(|tbl| tbl.cell_count()).sum();
        assert_eq!(total, base);
        println!("  {k:>6}  {n:>10}  {dt:>10.2?}  {total:>10}");
    }
    println!();
}
