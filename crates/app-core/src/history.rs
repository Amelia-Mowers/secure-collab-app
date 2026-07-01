//! Change history + rollback.
//!
//! Everything in the system is LWW cells (see `architecture.md`), so history and
//! rollback are built entirely on the existing `cell.update` event stream — there
//! is **no new event type**:
//!
//! - **As-of-a-point state** ([`state_as_of`]) is an LWW fold over the events
//!   whose Matrix `server_timestamp` is at or before a target point — an
//!   intuitive "what did the table look like at `<time>`".
//! - **Rollback** ([`rollback_updates`]) diffs the current materialized state
//!   against the as-of-point state and emits ordinary `cell.update`s that restore
//!   the differences (fresh logical timestamps → they LWW-win). Because a revert
//!   is just more cell data, materialization is unchanged and convergence /
//!   compaction are unaffected.
//! - The revert is also recorded as one row in the [`HISTORY_TABLE_ID`] system
//!   table (the user-facing "rollback message") via [`HistoryManager`]. That row
//!   is what the History drawer renders as a single "reverted to `<time>`" entry.
//! - **Revert-a-revert** composes for free: it is just another rollback whose
//!   target is the pre-revert point.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use tables_over_matrix::{Cell, CellId, CellUpdate, Table};

/// System table holding one row per revert — the user-facing "rollback message".
pub const HISTORY_TABLE_ID: &str = "_history";

/// A recorded revert: one row in [`HISTORY_TABLE_ID`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RevertRecord {
    /// Stable, unique row id in `_history` (the caller supplies it — the bridge
    /// mints it, since the pure core has no randomness on wasm).
    pub id: String,
    /// Matrix user id that performed the revert.
    pub actor: String,
    /// The point the scope was reverted TO, as a Matrix `origin_server_ts` (ms).
    pub target: u64,
    /// What was reverted: a specific `table_id`, or `"*"` for the whole workspace.
    pub scope: String,
    /// Optional human label shown in the drawer.
    pub label: Option<String>,
}

/// LWW-fold `events` considering only those at or before `target_server_ts`
/// (by Matrix `server_timestamp`), yielding the winning [`Cell`] per [`CellId`] —
/// i.e. the materialized state as it stood at that point in wall-clock time.
///
/// Events with no `server_timestamp` (local, not-yet-echoed writes) are treated
/// as `0` so a fetched historical timeline — whose events always carry the
/// envelope time — folds correctly.
pub fn state_as_of(events: &[CellUpdate], target_server_ts: u64) -> HashMap<CellId, Cell> {
    let mut winners: HashMap<CellId, Cell> = HashMap::new();
    for update in events {
        if update.server_timestamp.unwrap_or(0) > target_server_ts {
            continue;
        }
        let cell = update.to_cell();
        match winners.get(&cell.id) {
            Some(existing) if !cell.wins_over(existing) => {}
            _ => {
                winners.insert(cell.id.clone(), cell);
            }
        }
    }
    winners
}

/// Produce the `cell.update`s that transform `current` into `as_of`, restricted
/// to the cells for which `in_scope` returns true. Each successive update is
/// stamped `next_ts, next_ts + 1, …` (the caller passes a fresh HLC base so the
/// restores LWW-win over the current values).
///
/// Scope is a predicate (not just a `table_id`) so a table rollback can also
/// pull in that table's `_schema`/`_tables` rows — reverting a column/table
/// deletion so previously-hidden data (gone "stale" past a `deleted_at` cutoff)
/// comes back **live**, not merely restored-but-still-hidden.
///
/// A cell present now but absent at the target point is reverted to `Value::Null`
/// (an addition being undone); a cell whose value already matches is skipped.
/// Output is sorted by `(table, row, column)` for deterministic batching/tests.
pub fn rollback_updates(
    current: &HashMap<CellId, Cell>,
    as_of: &HashMap<CellId, Cell>,
    in_scope: impl Fn(&CellId) -> bool,
    next_ts: u64,
) -> Vec<CellUpdate> {
    let mut ids: Vec<&CellId> = current
        .keys()
        .chain(as_of.keys())
        .filter(|id| in_scope(id))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    ids.sort_by(|a, b| {
        (&a.table_id, &a.row_id, &a.column_id).cmp(&(&b.table_id, &b.row_id, &b.column_id))
    });

    let mut ts = next_ts;
    let mut updates = Vec::new();
    for id in ids {
        let target = as_of.get(id).map(|c| c.value.clone());
        let now = current.get(id).map(|c| &c.value);
        // Skip no-ops: value already matches, or the cell was absent then and is
        // absent now (nothing to restore).
        let restore = match (now, &target) {
            (Some(cur), Some(tgt)) => cur != tgt,
            (Some(_), None) => true, // exists now, absent at point → clear
            (None, Some(tgt)) => !tgt.is_null(), // absent now, had a value → restore
            (None, None) => false,
        };
        if restore {
            let value = target.unwrap_or(Value::Null);
            updates.push(CellUpdate::new(
                id.table_id.clone(),
                id.row_id.clone(),
                id.column_id.clone(),
                value,
                ts,
            ));
            ts += 1;
        }
    }
    updates
}

/// Manages the `_history` system table (one row per revert). Mirrors
/// [`crate::schema::SchemaManager`]: it holds a [`Table`], turns operations into
/// [`CellUpdate`]s (applied locally + returned for sending), and exports its
/// cells for the workspace snapshot.
pub struct HistoryManager {
    table: Table,
}

impl HistoryManager {
    pub fn new() -> Self {
        Self {
            table: Table::new(HISTORY_TABLE_ID),
        }
    }

    /// Write the row that records a revert (the "rollback message"). Applies the
    /// cells locally and returns them for sending. Cells are stamped
    /// `timestamp, timestamp + 1, …`.
    pub fn record_revert(&mut self, record: &RevertRecord, timestamp: u64) -> Vec<CellUpdate> {
        let mut updates = Vec::new();
        let mut ts = timestamp;
        let mut write = |col: &str, val: Value, table: &mut Table, out: &mut Vec<CellUpdate>| {
            let update = CellUpdate::new(HISTORY_TABLE_ID, &record.id, col, val, ts);
            table.apply_update(update.clone());
            out.push(update);
            ts += 1;
        };
        write("kind", json!("revert"), &mut self.table, &mut updates);
        write("actor", json!(record.actor), &mut self.table, &mut updates);
        write(
            "target",
            json!(record.target),
            &mut self.table,
            &mut updates,
        );
        write("scope", json!(record.scope), &mut self.table, &mut updates);
        if let Some(label) = &record.label {
            write("label", json!(label), &mut self.table, &mut updates);
        }
        updates
    }

    /// All recorded reverts, newest-`target` first is *not* guaranteed — order is
    /// row iteration order; the UI sorts by the row's own event time.
    pub fn list_reverts(&self) -> Vec<RevertRecord> {
        let str_field = |row: &str, col: &str| -> Option<String> {
            self.table
                .get_value(row, col)
                .and_then(|v| v.as_str().map(String::from))
        };
        let mut out = Vec::new();
        for row_id in self.table.rows() {
            if str_field(&row_id, "kind").as_deref() != Some("revert") {
                continue;
            }
            out.push(RevertRecord {
                actor: str_field(&row_id, "actor").unwrap_or_default(),
                target: self
                    .table
                    .get_value(&row_id, "target")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                scope: str_field(&row_id, "scope").unwrap_or_else(|| "*".to_string()),
                label: str_field(&row_id, "label"),
                id: row_id,
            });
        }
        out
    }

    /// Apply updates addressed to the `_history` table (others are ignored).
    pub fn apply_updates(&mut self, updates: Vec<CellUpdate>) {
        for update in updates {
            if update.table_id == HISTORY_TABLE_ID {
                self.table.apply_update(update);
            }
        }
    }

    /// Winning cells of the `_history` table for a workspace snapshot.
    pub fn export_cells(&self) -> Vec<Cell> {
        self.table.export_cells()
    }
}

impl Default for HistoryManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a wire `CellUpdate` with a server timestamp (as a fetched timeline
    /// event would carry).
    fn ev(row: &str, col: &str, val: Value, logical: u64, server: u64) -> CellUpdate {
        CellUpdate::new("t", row, col, val, logical).with_server_timestamp(server)
    }

    fn val_at(state: &HashMap<CellId, Cell>, row: &str, col: &str) -> Option<Value> {
        state
            .get(&CellId::new("t", row, col))
            .map(|c| c.value.clone())
    }

    #[test]
    fn state_as_of_takes_the_lww_winner_at_or_before_the_point() {
        let events = vec![
            ev("r1", "c", json!("a"), 1, 100),
            ev("r1", "c", json!("b"), 2, 200),
            ev("r1", "c", json!("c"), 3, 300),
        ];
        // At t=250 only the first two events count; LWW winner is "b".
        let s = state_as_of(&events, 250);
        assert_eq!(val_at(&s, "r1", "c"), Some(json!("b")));
        // At t=300 all three; winner "c".
        let s = state_as_of(&events, 300);
        assert_eq!(val_at(&s, "r1", "c"), Some(json!("c")));
        // Before anything: empty.
        assert!(state_as_of(&events, 50).is_empty());
    }

    #[test]
    fn state_as_of_uses_logical_ts_for_lww_not_arrival() {
        // Out-of-order server times but logical ts decides the winner among the
        // in-window events.
        let events = vec![
            ev("r", "c", json!("newer"), 5, 100),
            ev("r", "c", json!("older"), 2, 150),
        ];
        // Both within window (<=200): logical 5 > 2 → "newer" wins.
        assert_eq!(
            val_at(&state_as_of(&events, 200), "r", "c"),
            Some(json!("newer"))
        );
        // Only the server=100 event is in-window at t=120 → "newer".
        assert_eq!(
            val_at(&state_as_of(&events, 120), "r", "c"),
            Some(json!("newer"))
        );
    }

    #[test]
    fn rollback_restores_changed_cells_and_clears_additions() {
        let events = vec![
            ev("r1", "c", json!("orig"), 1, 100),
            ev("r1", "c", json!("edited"), 2, 200), // changed after the point
            ev("r2", "c", json!("added"), 3, 300),  // added after the point
        ];
        let current = state_as_of(&events, 999);
        let as_of = state_as_of(&events, 150); // r1=orig, r2 absent
        let updates = rollback_updates(&current, &as_of, |id: &CellId| id.table_id == "t", 1000);

        // r1 restored to "orig"; r2 cleared to null.
        let by_cell: HashMap<(String, String), Value> = updates
            .iter()
            .map(|u| ((u.row_id.clone(), u.column_id.clone()), u.value.clone()))
            .collect();
        assert_eq!(
            by_cell.get(&("r1".into(), "c".into())),
            Some(&json!("orig"))
        );
        assert_eq!(by_cell.get(&("r2".into(), "c".into())), Some(&json!(null)));
        assert_eq!(updates.len(), 2);
        // Fresh, strictly increasing timestamps so the restores LWW-win.
        assert!(updates.iter().all(|u| u.timestamp >= 1000));
    }

    #[test]
    fn rollback_skips_unchanged_cells() {
        let events = vec![ev("r1", "c", json!("same"), 1, 100)];
        let current = state_as_of(&events, 999);
        let as_of = state_as_of(&events, 150);
        // Nothing changed between the point and now → no updates.
        assert!(
            rollback_updates(&current, &as_of, |id: &CellId| id.table_id == "t", 1000).is_empty()
        );
    }

    #[test]
    fn rollback_scope_limits_to_one_table() {
        let mut current = HashMap::new();
        current.insert(
            CellId::new("t1", "r", "c"),
            CellUpdate::new("t1", "r", "c", json!("x"), 2).to_cell(),
        );
        current.insert(
            CellId::new("t2", "r", "c"),
            CellUpdate::new("t2", "r", "c", json!("y"), 2).to_cell(),
        );
        let as_of = HashMap::new(); // both absent at the point
        let updates = rollback_updates(&current, &as_of, |id: &CellId| id.table_id == "t1", 500);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].table_id, "t1");
    }

    #[test]
    fn rollback_scope_can_include_schema_rows_to_undelete() {
        // A column deleted AFTER the target point: current carries deleted=true +
        // a deleted_at cutoff (which hides the data); at the target neither
        // exists. A table rollback whose scope predicate covers the table's
        // `_schema` rows must revert those markers so the (unchanged) data stops
        // being hidden — "stale before the reversion, live after".
        let mut current: HashMap<CellId, Cell> = HashMap::new();
        current.insert(
            CellId::new("_schema", "tasks.title", "deleted"),
            CellUpdate::new("_schema", "tasks.title", "deleted", json!(true), 5).to_cell(),
        );
        current.insert(
            CellId::new("_schema", "tasks.title", "deleted_at"),
            CellUpdate::new("_schema", "tasks.title", "deleted_at", json!(2000), 5).to_cell(),
        );
        current.insert(
            CellId::new("tasks", "r1", "title"),
            CellUpdate::new("tasks", "r1", "title", json!("hello"), 1).to_cell(),
        );

        // At the point: no deletion markers, same data.
        let mut as_of: HashMap<CellId, Cell> = HashMap::new();
        as_of.insert(
            CellId::new("tasks", "r1", "title"),
            CellUpdate::new("tasks", "r1", "title", json!("hello"), 1).to_cell(),
        );

        let updates = rollback_updates(
            &current,
            &as_of,
            |id: &CellId| {
                id.table_id == "tasks"
                    || (id.table_id == "_schema" && id.row_id.starts_with("tasks."))
            },
            1000,
        );
        let by: HashMap<(String, String), Value> = updates
            .iter()
            .map(|u| ((u.row_id.clone(), u.column_id.clone()), u.value.clone()))
            .collect();
        // Deletion markers cleared (→ null), so the cutoff no longer hides data.
        assert_eq!(
            by.get(&("tasks.title".into(), "deleted".into())),
            Some(&json!(null))
        );
        assert_eq!(
            by.get(&("tasks.title".into(), "deleted_at".into())),
            Some(&json!(null))
        );
        // The data cell itself was unchanged across the deletion → not re-emitted.
        assert!(!by.contains_key(&("r1".into(), "title".into())));
    }

    #[test]
    fn revert_a_revert_returns_to_the_forward_state() {
        // Timeline: v=A@(1,100), v=B@(2,200). Roll back to 150 (→A), applying the
        // restore as a new event at (3,300). Reverting THAT revert = rolling back
        // to a point after B but before the restore (e.g. 250) → forward value B.
        let mut events = vec![
            ev("r", "c", json!("A"), 1, 100),
            ev("r", "c", json!("B"), 2, 200),
        ];
        let current = state_as_of(&events, 999);
        let as_of = state_as_of(&events, 150);
        let restore = rollback_updates(&current, &as_of, |id: &CellId| id.table_id == "t", 3);
        assert_eq!(restore[0].value, json!("A"));
        // Simulate the restore landing on the timeline at server=300.
        events.push(restore[0].clone().with_server_timestamp(300));

        // Now current shows "A" (the restore is newest). Revert-the-revert to a
        // point just after B (250) → "B".
        let current2 = state_as_of(&events, 999);
        assert_eq!(val_at(&current2, "r", "c"), Some(json!("A")));
        let as_of2 = state_as_of(&events, 250);
        let restore2 = rollback_updates(&current2, &as_of2, |id: &CellId| id.table_id == "t", 5);
        assert_eq!(restore2[0].value, json!("B"));
    }

    #[test]
    fn history_manager_records_and_reads_back_a_revert() {
        let mut mgr = HistoryManager::new();
        let rec = RevertRecord {
            id: "rev-1".to_string(),
            actor: "@alice:example.org".to_string(),
            target: 12345,
            scope: "tasks".to_string(),
            label: Some("oops".to_string()),
        };
        let updates = mgr.record_revert(&rec, 1000);
        assert!(!updates.is_empty());
        assert!(updates.iter().all(|u| u.table_id == HISTORY_TABLE_ID));

        let reverts = mgr.list_reverts();
        assert_eq!(reverts.len(), 1);
        assert_eq!(reverts[0], rec);
    }

    #[test]
    fn history_manager_apply_updates_ignores_other_tables() {
        let mut mgr = HistoryManager::new();
        mgr.apply_updates(vec![CellUpdate::new("tasks", "r", "c", json!("x"), 1)]);
        assert!(mgr.list_reverts().is_empty());
    }

    #[test]
    fn history_manager_round_trips_through_export_cells() {
        let mut mgr = HistoryManager::new();
        mgr.record_revert(
            &RevertRecord {
                id: "rev-1".to_string(),
                actor: "@a:b".to_string(),
                target: 7,
                scope: "*".to_string(),
                label: None,
            },
            10,
        );
        let cells = mgr.export_cells();
        // Replaying the exported cells into a fresh manager reconstructs the revert.
        let mut restored = HistoryManager::new();
        restored.apply_updates(cells.into_iter().map(CellUpdate::from_cell).collect());
        assert_eq!(restored.list_reverts().len(), 1);
    }
}
