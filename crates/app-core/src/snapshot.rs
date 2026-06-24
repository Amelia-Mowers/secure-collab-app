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

use serde::{Deserialize, Serialize};
use tables_over_matrix::Cell;

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
}
