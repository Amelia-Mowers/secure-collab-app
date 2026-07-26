//! Persisted workspace snapshot for incremental cold start (issue 6f092cf4).
//!
//! Today opening a workspace re-paginates the *entire* room history on every
//! cold start. A snapshot lets a reload instead load the last materialized
//! state from a local store and fetch only the events newer than a marker.
//!
//! A snapshot is the flat set of winning [`Cell`]s across the whole workspace
//! (user tables + the `_schema`/`_tables`/`_views` system tables), plus:
//!  - `marker_ts`: the highest Matrix `origin_server_ts` (ms) folded in — the
//!    resume point for the bounded incremental gather, and
//!  - `timestamp_counter`: the hybrid logical clock, so post-load local writes
//!    stay ordered after the loaded history.
//!
//! Correctness rests on the LWW (last-write-wins) model: cell values are
//! order-independent, so "snapshot + only-newer events, applied in any order"
//! converges to the same state as a full replay (see the convergence tests in
//! `workspace.rs`). We store the flat cell list rather than the [`Table`]
//! structs because their cell maps are keyed by `(row, column)` tuples, which
//! JSON can't represent as object keys.
//!
//! [`Table`]: tables_over_matrix::Table
//!
//! Security: a snapshot holds DECRYPTED workspace data and is persisted as-is
//! (plaintext at rest). The matrix-rust-sdk store already keeps the room keys
//! needed to decrypt the same history locally, so the marginal exposure is
//! small; encrypting local stores at rest holistically is tracked separately
//! (issue c72ec5df) and would wrap this blob too.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tables_over_matrix::{Cell, CellId};

/// Snapshot schema version. Bump on an incompatible shape change; the loader
/// ignores a non-matching version and falls back to a full history gather.
pub const SNAPSHOT_VERSION: u32 = 1;

/// A serializable, persistable snapshot of a workspace's materialized state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    /// Schema version; see [`SNAPSHOT_VERSION`].
    pub version: u32,
    /// Highest Matrix `origin_server_ts` (ms) folded into this snapshot — the
    /// resume point for the bounded incremental gather on reload.
    pub marker_ts: u64,
    /// Hybrid logical clock at snapshot time.
    pub timestamp_counter: u64,
    /// Count of undecryptable events at snapshot time. Non-zero means the
    /// snapshot is incomplete, so the loader does a full gather (retrying
    /// decryption in case keys have since arrived) instead of the fast path.
    #[serde(default)]
    pub undecryptable_count: u32,
    /// Every winning cell across the workspace; replay via
    /// `Workspace::apply_update` to reconstruct.
    pub cells: Vec<Cell>,
}

impl WorkspaceSnapshot {
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    pub fn from_json(s: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(s)
    }

    /// Whether this snapshot can drive the incremental fast path: the version
    /// matches and it was fully decryptable. Otherwise the caller should do a
    /// full history gather.
    pub fn is_fast_path_usable(&self) -> bool {
        self.version == SNAPSHOT_VERSION && self.undecryptable_count == 0
    }
}

/// Skew tolerance for the incremental cold-start walk (issue 48f042ba).
/// `/messages` follows the server's STREAM order, which can disagree with
/// `origin_server_ts` by persister skew when Synapse runs workers / stream
/// writers. The margin bounds how much disagreement the walk tolerates before
/// concluding it has really passed the snapshot marker.
pub const REORDER_GRACE_MS: u64 = 30_000;

/// Whether the incremental cold-start walk has convincingly passed the
/// snapshot marker and may stop paginating (issue 48f042ba).
///
/// `page_oldest` is the oldest parseable `origin_server_ts` on the page just
/// processed; `stop_before` is the snapshot marker. The old rule — abandon the
/// entire walk at the FIRST event nominally older than the marker — assumed
/// stream order and `origin_server_ts` agree. Under workers they need not: one
/// reordered event then truncated the walk, every event deeper in the stream
/// was skipped, and because the running marker had already advanced past them,
/// no later incremental start would ever fetch them — a permanent,
/// self-sealing hole (8 events lost in prod on 2026-07-25). Now a page must
/// trail the marker by more than [`REORDER_GRACE_MS`] before the walk stops:
/// an event is lost only if the two orders disagree by over the margin.
///
/// A full gather (`fast_path == false`) never stops early, and a page with no
/// parseable timestamps cannot justify stopping.
pub fn backfill_caught_up(fast_path: bool, page_oldest: Option<u64>, stop_before: u64) -> bool {
    fast_path && page_oldest.is_some_and(|t| t.saturating_add(REORDER_GRACE_MS) < stop_before)
}

/// What an integrity check found (issue 48f042ba).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct IntegrityReport {
    /// Cells the server holds.
    pub checked: usize,
    /// Server cells we hold no version of at all — the shape of the 2026-07-25
    /// incident, where a truncated walk dropped 8 row-add events.
    pub missing: usize,
    /// Server cells we hold an OLDER version of.
    pub stale: usize,
}

/// Compare a full re-gather of the server's history against the local
/// materialization, and return both the report and the cells to re-apply.
///
/// Lives here, not in the wasm bridge, for the same reason
/// [`backfill_caught_up`] does: the bug this whole issue is about shipped
/// because the rule that governed it could not be unit-tested natively.
///
/// Deliberately one-directional. A cell we hold that the server does not is
/// **not** a fault — unsent local writes sit in the outbox and legitimately
/// lead the server, and treating that as corruption would make the check cry
/// wolf on every pending edit.
pub fn integrity_diff(local: &[Cell], server: &[Cell]) -> (IntegrityReport, Vec<Cell>) {
    let mine: HashMap<&CellId, &Cell> = local.iter().map(|c| (&c.id, c)).collect();
    let mut report = IntegrityReport {
        checked: server.len(),
        ..Default::default()
    };
    let mut repairs = Vec::new();
    for cell in server {
        match mine.get(&cell.id) {
            None => {
                report.missing += 1;
                repairs.push(cell.clone());
            }
            Some(ours) if lww_key(cell) > lww_key(ours) => {
                report.stale += 1;
                repairs.push(cell.clone());
            }
            Some(_) => {}
        }
    }
    (report, repairs)
}

/// LWW ordering key: the hybrid logical clock, then `origin_server_ts` as the
/// tiebreaker — the same precedence the merge itself uses.
fn lww_key(cell: &Cell) -> (u64, u64) {
    (cell.timestamp, cell.server_timestamp.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Workspace;
    use serde_json::json;
    use tables_over_matrix::CellUpdate;

    fn sample_workspace() -> Workspace {
        let mut ws = Workspace::new("w");
        ws.create_table(
            crate::schema::TableDefinition::new("tasks", "Tasks").with_column(
                crate::schema::ColumnDefinition::new(
                    "title",
                    "Title",
                    crate::schema::ColumnType::Text,
                ),
            ),
        )
        .unwrap();
        ws.update_cell("tasks", "r1", "title", json!("hello"))
            .unwrap();
        ws
    }

    #[test]
    fn test_snapshot_json_round_trip() {
        let ws = sample_workspace();
        let snap = WorkspaceSnapshot {
            version: SNAPSHOT_VERSION,
            marker_ts: 42,
            timestamp_counter: ws.timestamp_counter(),
            undecryptable_count: 0,
            cells: ws.export_cells(),
        };
        let json = snap.to_json().unwrap();
        let back = WorkspaceSnapshot::from_json(&json).unwrap();
        assert_eq!(back.version, SNAPSHOT_VERSION);
        assert_eq!(back.marker_ts, 42);
        assert_eq!(back.cells.len(), snap.cells.len());

        // Reloading the round-tripped snapshot reconstructs the table value.
        let mut loaded = Workspace::new("w");
        loaded.load_cells(back.cells, back.timestamp_counter);
        assert_eq!(
            loaded.get_table("tasks").unwrap().get_value("r1", "title"),
            Some(&json!("hello"))
        );
    }

    #[test]
    fn test_fast_path_gating() {
        let mut snap = WorkspaceSnapshot {
            version: SNAPSHOT_VERSION,
            marker_ts: 0,
            timestamp_counter: 0,
            undecryptable_count: 0,
            cells: vec![],
        };
        assert!(snap.is_fast_path_usable());
        // Wrong version → not usable.
        snap.version = SNAPSHOT_VERSION + 1;
        assert!(!snap.is_fast_path_usable());
        // Incomplete (had undecryptable events) → not usable.
        snap.version = SNAPSHOT_VERSION;
        snap.undecryptable_count = 1;
        assert!(!snap.is_fast_path_usable());
    }

    #[test]
    fn test_server_timestamp_tiebreaker_survives_snapshot() {
        // A cell whose value was decided by the server-timestamp tiebreaker must
        // keep that tiebreaker through a snapshot (Cell serializes it, even
        // though CellUpdate skips it on the wire).
        let mut ws = Workspace::new("w");
        ws.create_table(crate::schema::TableDefinition::new("t", "T").with_column(
            crate::schema::ColumnDefinition::new("c", "C", crate::schema::ColumnType::Text),
        ))
        .unwrap();
        // Two equal-logical-ts writes; higher server ts (B) wins.
        ws.apply_update(CellUpdate::new("t", "r", "c", json!("A"), 5).with_server_timestamp(100))
            .unwrap();
        ws.apply_update(CellUpdate::new("t", "r", "c", json!("B"), 5).with_server_timestamp(200))
            .unwrap();
        assert_eq!(
            ws.get_table("t").unwrap().get_value("r", "c"),
            Some(&json!("B"))
        );

        let mut loaded = Workspace::new("w");
        loaded.load_cells(ws.export_cells(), ws.timestamp_counter());
        // After reload, a stale-but-equal-ts write with a LOWER server ts must
        // still lose to the snapshot's B.
        loaded
            .apply_update(CellUpdate::new("t", "r", "c", json!("C"), 5).with_server_timestamp(150))
            .unwrap();
        assert_eq!(
            loaded.get_table("t").unwrap().get_value("r", "c"),
            Some(&json!("B")),
            "server-timestamp tiebreaker must survive the snapshot"
        );
    }

    /// Faithful reload repro: a workspace shaped like the core E2E (table +
    /// columns added after creation + rows + an inline edit + a view) must
    /// fully survive snapshot -> JSON -> load_cells. The earlier round-trip test
    /// only checked a raw cell value; it never exercised `get_table_schema`
    /// (which reads the `_tables` registry name and makes the bridge throw
    /// "Table not found" if missing) or the views.
    #[test]
    fn test_full_workspace_round_trip() {
        use crate::schema::{ColumnDefinition, ColumnType, TableDefinition};
        use crate::views::{ViewConfig, ViewType};

        let mut ws = Workspace::new("w");
        ws.create_table(
            TableDefinition::new("tasks", "Tasks").with_column(ColumnDefinition::new(
                "name",
                "Name",
                ColumnType::Text,
            )),
        )
        .unwrap();
        // Columns added AFTER table creation (separate _schema writes).
        ws.add_column(
            "tasks",
            ColumnDefinition::new("priority", "Priority", ColumnType::Select),
        )
        .unwrap();
        ws.add_column(
            "tasks",
            ColumnDefinition::new("points", "Points", ColumnType::Number),
        )
        .unwrap();
        ws.add_column(
            "tasks",
            ColumnDefinition::new("done", "Done", ColumnType::Boolean),
        )
        .unwrap();

        ws.update_cell("tasks", "r1", "name", json!("Alpha task"))
            .unwrap();
        ws.update_cell("tasks", "r1", "priority", json!("High"))
            .unwrap();
        ws.update_cell("tasks", "r1", "points", json!(3)).unwrap();
        ws.update_cell("tasks", "r1", "done", json!(true)).unwrap();
        ws.update_cell("tasks", "r2", "name", json!("Beta task"))
            .unwrap();
        ws.update_cell("tasks", "r3", "name", json!("Gamma task"))
            .unwrap();
        // Inline edit: the later write must win LWW after reload.
        ws.update_cell("tasks", "r2", "name", json!("Beta task v2"))
            .unwrap();

        ws.create_view(ViewConfig::new(
            "tasks-board",
            "Board",
            "tasks",
            ViewType::Kanban,
        ))
        .unwrap();

        // snapshot -> json -> load into a fresh workspace
        let snap = WorkspaceSnapshot {
            version: SNAPSHOT_VERSION,
            marker_ts: 0,
            timestamp_counter: ws.timestamp_counter(),
            undecryptable_count: 0,
            cells: ws.export_cells(),
        };
        let json = snap.to_json().unwrap();
        let back = WorkspaceSnapshot::from_json(&json).unwrap();
        let mut loaded = Workspace::new("w");
        loaded.load_cells(back.cells, back.timestamp_counter);

        // Table is listed.
        assert!(
            loaded.list_tables().contains(&"tasks".to_string()),
            "table not listed after reload"
        );
        // Schema (registry name + every column) survives.
        let schema = loaded
            .get_table_schema("tasks")
            .expect("get_table_schema returned None after reload");
        assert_eq!(schema.name, "Tasks");
        let col_ids: std::collections::HashSet<&str> =
            schema.columns.values().map(|c| c.id.as_str()).collect();
        for c in ["name", "priority", "points", "done"] {
            assert!(col_ids.contains(c), "column {c} missing after reload");
        }
        // Row values incl. the edited one.
        let t = loaded.get_table("tasks").unwrap();
        assert_eq!(t.get_value("r1", "name"), Some(&json!("Alpha task")));
        assert_eq!(t.get_value("r1", "done"), Some(&json!(true)));
        assert_eq!(
            t.get_value("r2", "name"),
            Some(&json!("Beta task v2")),
            "inline edit lost after reload"
        );
        // Views survive and resolve.
        assert!(
            loaded
                .list_views_for_table("tasks")
                .contains(&"tasks-board".to_string()),
            "view not listed after reload"
        );
        assert!(
            loaded.get_view("tasks-board").is_some(),
            "get_view returned None after reload"
        );
    }

    #[test]
    fn backfill_never_stops_a_full_gather() {
        // No snapshot -> the walk must reach the beginning of history.
        assert!(!backfill_caught_up(false, Some(0), u64::MAX));
    }

    #[test]
    fn backfill_requires_clearing_the_marker_by_the_grace_margin() {
        let marker = 1_000_000;
        // A page whose oldest event nominally trails the marker — but within
        // the skew margin — must NOT stop the walk. This is the exact shape of
        // the prod incident: one worker-reordered event just below the marker
        // used to truncate the walk and permanently skip the deeper tail.
        assert!(!backfill_caught_up(true, Some(marker - 1), marker));
        assert!(!backfill_caught_up(
            true,
            Some(marker - REORDER_GRACE_MS),
            marker
        ));
        // Convincingly past the marker: stop.
        assert!(backfill_caught_up(
            true,
            Some(marker - REORDER_GRACE_MS - 1),
            marker
        ));
    }

    fn cell(table: &str, row: &str, col: &str, ts: u64) -> Cell {
        Cell::new(CellId::new(table, row, col), serde_json::json!("v"), ts)
    }

    #[test]
    fn integrity_diff_reports_the_incident_shape() {
        // The 2026-07-25 incident: rows the server has that we never applied.
        let server = vec![
            cell("issues", "r1", "name", 10),
            cell("issues", "r2", "name", 11),
        ];
        let local = vec![cell("issues", "r1", "name", 10)];
        let (report, repairs) = integrity_diff(&local, &server);
        assert_eq!(report.checked, 2);
        assert_eq!(report.missing, 1);
        assert_eq!(report.stale, 0);
        assert_eq!(repairs.len(), 1);
        assert_eq!(repairs[0].id.row_id, "r2");
    }

    #[test]
    fn integrity_diff_flags_an_older_local_cell() {
        let server = vec![cell("t", "r", "c", 20)];
        let local = vec![cell("t", "r", "c", 10)];
        let (report, repairs) = integrity_diff(&local, &server);
        assert_eq!((report.missing, report.stale), (0, 1));
        assert_eq!(repairs.len(), 1);
    }

    #[test]
    fn a_pending_local_write_is_not_a_fault() {
        // Unsent edits legitimately lead the server. Reporting them as
        // corruption would make the check cry wolf on every pending edit.
        let server = vec![cell("t", "r", "c", 10)];
        let local = vec![cell("t", "r", "c", 20), cell("t", "r2", "c", 5)];
        let (report, repairs) = integrity_diff(&local, &server);
        assert_eq!((report.missing, report.stale), (0, 0));
        assert!(repairs.is_empty());
    }

    #[test]
    fn equal_cells_need_no_repair() {
        let both = vec![cell("t", "r", "c", 10)];
        let (report, repairs) = integrity_diff(&both, &both);
        assert_eq!(
            report,
            IntegrityReport {
                checked: 1,
                missing: 0,
                stale: 0
            }
        );
        assert!(repairs.is_empty());
    }

    #[test]
    fn server_timestamp_breaks_a_logical_clock_tie() {
        let mut newer = cell("t", "r", "c", 10);
        newer.server_timestamp = Some(200);
        let mut older = cell("t", "r", "c", 10);
        older.server_timestamp = Some(100);
        assert_eq!(integrity_diff(&[older], &[newer]).0.stale, 1);
    }

    #[test]
    fn backfill_is_fail_safe_on_missing_timestamps() {
        // A page with no parseable origin_server_ts can't justify stopping —
        // keep walking rather than risk skipping.
        assert!(!backfill_caught_up(true, None, 1_000_000));
        // Overflow-safe near u64::MAX.
        assert!(!backfill_caught_up(true, Some(u64::MAX), u64::MAX));
    }
}
