//! Workspace lifecycle and management.

use crate::history::{HistoryManager, RevertRecord};
use crate::schema::{SchemaManager, TableDefinition};
use crate::views::{ViewConfig, ViewManager};
use crate::Result;
use std::collections::HashMap;
use tables_over_matrix::{Cell, CellId, CellUpdate, CompactionManager, Table, ROW_DELETED_COLUMN};

/// Empty for default-substitution purposes: `null` or `""` (a missing cell is
/// handled by the callers' `is_none_or`).
fn value_is_empty(v: &serde_json::Value) -> bool {
    v.is_null() || v.as_str().is_some_and(|s| s.is_empty())
}
#[cfg(not(target_arch = "wasm32"))]
use tracing::info;

#[cfg(feature = "matrix")]
use tables_over_matrix::MatrixClient;

/// Current wall-clock time in milliseconds since the Unix epoch — the physical
/// component of the hybrid logical clock.
///
/// On wasm32 we use the browser clock (`js_sys::Date::now`) because
/// `std::time::SystemTime` panics there; on native targets we use `SystemTime`.
#[cfg(not(target_arch = "wasm32"))]
fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
fn now_millis() -> u64 {
    js_sys::Date::now() as u64
}

#[cfg(all(target_arch = "wasm32", not(feature = "wasm")))]
fn now_millis() -> u64 {
    // No clock source available in this configuration; the hybrid logical clock
    // degrades to a pure monotonic counter (still correct, just not wall-clock-aligned).
    0
}

/// A workspace containing tables, schema, and views.
pub struct Workspace {
    /// Workspace ID (maps to Matrix room ID)
    pub id: String,
    /// User data tables indexed by table_id
    tables: HashMap<String, Table>,
    /// Schema manager for system tables
    schema_manager: SchemaManager,
    /// View manager
    view_manager: ViewManager,
    /// History manager for the `_history` system table (revert records)
    history_manager: HistoryManager,
    /// Compaction helper for order-based bumping
    compaction_manager: CompactionManager,
    /// Hybrid logical clock: the highest timestamp seen or generated so far
    /// (≈ Unix ms). Advanced by both local writes and observed updates.
    timestamp_counter: u64,
    /// Matrix client (when connected)
    #[cfg(feature = "matrix")]
    matrix_client: Option<MatrixClient>,
    /// Whether we have an active Matrix connection
    #[cfg(feature = "matrix")]
    connected: bool,
}

impl Workspace {
    /// Create a new workspace
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            tables: HashMap::new(),
            schema_manager: SchemaManager::new(),
            view_manager: ViewManager::new(),
            history_manager: HistoryManager::new(),
            compaction_manager: CompactionManager::new(),
            timestamp_counter: 0,
            #[cfg(feature = "matrix")]
            matrix_client: None,
            #[cfg(feature = "matrix")]
            connected: false,
        }
    }

    /// Per-column read/bump cutoffs for a table: the column-deletion cutoffs
    /// (`column_clear_cutoffs`) plus the table-level `deleted_at` (if the table
    /// was deleted) applied as a floor across every column. This is what makes a
    /// re-created table id start blank — row data written at/before the table's
    /// deletion is filtered at read time and skipped by bump selection (so it
    /// can't be kept alive or resurrected), exactly like a deleted column.
    fn effective_cutoffs(&self, table_id: &str) -> HashMap<String, u64> {
        let mut cutoffs = self.schema_manager.column_clear_cutoffs(table_id);
        if let Some(floor) = self.schema_manager.table_deleted_at(table_id) {
            if let Some(table) = self.tables.get(table_id) {
                for col in table.columns() {
                    let e = cutoffs.entry(col).or_insert(0);
                    *e = (*e).max(floor);
                }
            }
        }
        cutoffs
    }

    /// Generate the next timestamp for a *local* write using a hybrid logical
    /// clock: `max(last_seen + 1, wall_clock_ms)`.
    ///
    /// This keeps timestamps (a) strictly monotonic per client even within the
    /// same millisecond and (b) comparable across clients (≈ Unix ms). Crucially,
    /// because the clock is advanced from every applied update (see
    /// [`observe_timestamp`](Self::observe_timestamp)), a write made right after
    /// cold-start replay still wins LWW against the history it just loaded.
    /// See ARCHITECTURE_REVIEW.md §4.1.
    fn next_timestamp(&mut self) -> u64 {
        let now = now_millis();
        self.timestamp_counter = self.timestamp_counter.saturating_add(1).max(now);
        self.timestamp_counter
    }

    /// Advance the clock to account for a timestamp observed on an applied
    /// update (local echo or remote). This is what seeds the clock from history
    /// during cold start and keeps local writes ahead of peers' timestamps.
    fn observe_timestamp(&mut self, ts: u64) {
        self.timestamp_counter = self.timestamp_counter.max(ts);
    }

    /// Test support: draw a workspace-consistent HLC timestamp.
    ///
    /// Not used by the bridges (they go through `update_cell_with_bump` /
    /// `apply_update`, which manage the clock internally) — the integration
    /// tests use this to hand-construct `CellUpdate`s whose timestamps
    /// participate in the same clock as the workspace's own writes.
    #[doc(hidden)]
    pub fn next_timestamp_pub(&mut self) -> u64 {
        self.next_timestamp()
    }

    /// Whether this workspace has a Matrix connection.
    #[cfg(feature = "matrix")]
    pub fn is_connected(&self) -> bool {
        self.connected
    }

    /// Get a reference to the Matrix client (if connected).
    #[cfg(feature = "matrix")]
    pub fn matrix_client(&self) -> Option<&MatrixClient> {
        self.matrix_client.as_ref()
    }

    /// Get a mutable reference to the Matrix client (if connected).
    #[cfg(feature = "matrix")]
    pub fn matrix_client_mut(&mut self) -> Option<&mut MatrixClient> {
        self.matrix_client.as_mut()
    }

    /// Set the Matrix client for this workspace.
    #[cfg(feature = "matrix")]
    pub fn set_matrix_client(&mut self, client: MatrixClient) {
        self.matrix_client = Some(client);
        self.connected = true;
    }

    /// Create a new table in the workspace
    pub fn create_table(&mut self, definition: TableDefinition) -> Result<Vec<CellUpdate>> {
        let table_id = definition.id.clone();

        // Reject a name/id that already exists, rather than silently merging the
        // new definition's columns into the existing table. A *deleted* table id
        // is treated as free: re-creating it is allowed (and clears the
        // tombstone via create_table's `deleted = false` write).
        if (self.tables.contains_key(&table_id)
            || self.schema_manager.get_table_schema(&table_id).is_some())
            && !self.schema_manager.is_table_deleted(&table_id)
        {
            return Err(crate::Error::TableAlreadyExists);
        }

        let timestamp = self.next_timestamp();

        // Create the schema updates - this now applies them internally!
        let updates = self.schema_manager.create_table(definition, timestamp);

        // Create the actual table
        self.tables.insert(table_id.clone(), Table::new(&table_id));

        #[cfg(not(target_arch = "wasm32"))]
        info!("Created table: {}", table_id);
        Ok(updates)
    }

    /// Add a column to an existing table's schema (does not touch data rows).
    pub fn add_column(
        &mut self,
        table_id: &str,
        column: crate::schema::ColumnDefinition,
    ) -> Result<Vec<CellUpdate>> {
        if !self.tables.contains_key(table_id) {
            return Err(crate::Error::TableNotFound);
        }
        let timestamp = self.next_timestamp();
        let updates = self.schema_manager.add_column(table_id, column, timestamp);
        Ok(updates)
    }

    /// Reorder a table's columns. `ordered_column_ids` is the new left-to-right
    /// order; returns the schema CellUpdates to persist.
    pub fn reorder_columns(
        &mut self,
        table_id: &str,
        ordered_column_ids: &[String],
    ) -> Result<Vec<CellUpdate>> {
        if !self.tables.contains_key(table_id) {
            return Err(crate::Error::TableNotFound);
        }
        let timestamp = self.next_timestamp();
        let updates = self
            .schema_manager
            .reorder_columns(table_id, ordered_column_ids, timestamp);
        Ok(updates)
    }

    /// Update mutable fields of a column (rename / retype / options / default).
    /// `patch` is a JSON object with any of `name`/`column_type`/`options`/
    /// `default_value`; returns the schema CellUpdates to persist.
    pub fn update_column(
        &mut self,
        table_id: &str,
        column_id: &str,
        patch: &serde_json::Value,
    ) -> Result<Vec<CellUpdate>> {
        if !self.tables.contains_key(table_id) {
            return Err(crate::Error::TableNotFound);
        }
        let mut updates = Vec::new();
        // Mass-init on default CHANGE (issue b4b9c90f): empty select cells read
        // as the current default, so rows relying on the OLD default must keep
        // it — write it into every actually-empty cell before the new default
        // takes over. Setting a FIRST default writes nothing: empties simply
        // start reading as it.
        if let Some(new_default) = patch.get("default_value") {
            let old_default = self
                .schema_manager
                .get_table_schema(table_id)
                .and_then(|s| s.columns.get(column_id).cloned())
                .filter(|c| matches!(c.column_type, crate::ColumnType::Select))
                .and_then(|c| c.default_value)
                .filter(|v| !value_is_empty(v));
            if let Some(old) = old_default {
                if old != *new_default {
                    let empty_rows: Vec<String> = self
                        .raw_table_rows(table_id)?
                        .iter()
                        .filter(|row| row.get(column_id).is_none_or(value_is_empty))
                        .filter_map(|row| {
                            row.get("_row_id")
                                .and_then(|v| v.as_str())
                                .map(String::from)
                        })
                        .collect();
                    for row_id in empty_rows {
                        let ts = self.next_timestamp();
                        let update = CellUpdate::new(table_id, &row_id, column_id, old.clone(), ts);
                        if let Some(table) = self.tables.get_mut(table_id) {
                            table.apply_update(update.clone());
                        }
                        updates.push(update);
                    }
                }
            }
        }
        let timestamp = self.next_timestamp();
        updates.extend(
            self.schema_manager
                .update_column(table_id, column_id, patch, timestamp),
        );
        Ok(updates)
    }

    /// Rename a table in place: rewrites just the `name` cell of its `_tables`
    /// row, leaving its columns and data alone.
    pub fn rename_table(&mut self, table_id: &str, name: &str) -> Result<Vec<CellUpdate>> {
        if !self.tables.contains_key(table_id) {
            return Err(crate::Error::TableNotFound);
        }
        let timestamp = self.next_timestamp();
        Ok(self.schema_manager.rename_table(table_id, name, timestamp))
    }

    /// Delete a column (decay model): marks it deleted in the schema. Returns the
    /// schema CellUpdates to persist.
    pub fn delete_column(&mut self, table_id: &str, column_id: &str) -> Result<Vec<CellUpdate>> {
        if !self.tables.contains_key(table_id) {
            return Err(crate::Error::TableNotFound);
        }
        let timestamp = self.next_timestamp();
        let updates = self
            .schema_manager
            .delete_column(table_id, column_id, timestamp);
        Ok(updates)
    }

    /// Create a new view for a table
    pub fn create_view(&mut self, config: ViewConfig) -> Result<Vec<CellUpdate>> {
        // Verify the table exists
        if !self.tables.contains_key(&config.table_id) {
            return Err(crate::Error::TableNotFound);
        }

        let timestamp = self.next_timestamp();
        let updates = self.view_manager.create_view(config.clone(), timestamp);

        // Apply the updates immediately so the view is persisted
        self.view_manager.apply_updates(updates.clone());

        #[cfg(not(target_arch = "wasm32"))]
        info!("Created view: {} for table: {}", config.id, config.table_id);
        Ok(updates)
    }

    /// Delete a view (decay model). Returns the tombstone CellUpdate to
    /// persist. Unknown ids are not an error — deleting twice converges.
    pub fn delete_view(&mut self, view_id: &str) -> Result<Vec<CellUpdate>> {
        let timestamp = self.next_timestamp();
        let updates = self.view_manager.delete_view(view_id, timestamp);
        self.view_manager.apply_updates(updates.clone());

        #[cfg(not(target_arch = "wasm32"))]
        info!("Tombstoned view: {}", view_id);

        Ok(updates)
    }

    /// Apply view updates
    pub fn apply_view_updates(&mut self, updates: Vec<CellUpdate>) -> Result<()> {
        self.view_manager.apply_updates(updates);
        Ok(())
    }

    /// Update a cell in a table
    pub fn update_cell(
        &mut self,
        table_id: &str,
        row_id: &str,
        column_id: &str,
        value: serde_json::Value,
    ) -> Result<()> {
        // Generate timestamp before borrowing table
        let user_timestamp = self.next_timestamp();
        let user_update = CellUpdate::new(table_id, row_id, column_id, value, user_timestamp);

        // Get mutable reference and apply
        match self.tables.get_mut(table_id) {
            Some(table) => {
                table.apply_update(user_update);
                Ok(())
            }
            None => Err(crate::Error::TableNotFound),
        }
    }

    /// Like [`update_cell`](Self::update_cell), but also emits an order-based
    /// **bump** of the stalest cell in the same table, and returns every
    /// `CellUpdate` that must be sent to Matrix (the user write, plus the bump
    /// when one applies).
    ///
    /// A bump re-emits the oldest cell's current value with a fresh timestamp,
    /// so that after roughly one cycle of writes every live cell has a recent
    /// timeline event — bounding the cold-start lookback to ~the table's cell
    /// count. This is used by the Matrix-connected write path; the local-only
    /// path uses [`update_cell`](Self::update_cell) (there is no timeline to
    /// bound). See ARCHITECTURE_REVIEW.md §4.3.
    ///
    /// System tables (`_schema`/`_views`) are low-churn and are intentionally
    /// not bumped here; their lookback is bounded by their (small) cell count.
    pub fn update_cell_with_bump(
        &mut self,
        table_id: &str,
        row_id: &str,
        column_id: &str,
        value: serde_json::Value,
    ) -> Result<Vec<CellUpdate>> {
        if !self.tables.contains_key(table_id) {
            return Err(crate::Error::TableNotFound);
        }

        let user_timestamp = self.next_timestamp();
        let user_update = CellUpdate::new(table_id, row_id, column_id, value, user_timestamp);
        let user_cell = user_update.cell_id();

        // Pick the stalest cell to bump from the table state *before* the user
        // write, and never bump the cell we're about to write. Exclude cells that
        // should decay (deleted rows / columns past their deletion cutoff, and a
        // deleted table's data past its cutoff) so a bump can't keep dead data
        // alive or resurrect it past a column/table delete.
        let cutoffs = self.effective_cutoffs(table_id);
        let candidate = {
            let table = self
                .tables
                .get(table_id)
                .ok_or(crate::Error::TableNotFound)?;
            self.compaction_manager
                .select_bump_candidate_excluding(table, &cutoffs)
        }
        .filter(|c| *c != user_cell);

        let mut updates = vec![user_update];

        if let Some(candidate) = candidate {
            let bump_timestamp = self.next_timestamp();
            let table = self
                .tables
                .get(table_id)
                .ok_or(crate::Error::TableNotFound)?;
            if let Some(bump) =
                self.compaction_manager
                    .create_bump_update(table, &candidate, bump_timestamp)
            {
                updates.push(bump);
            }
        }

        // Apply everything locally so our materialized table matches what we send.
        let table = self
            .tables
            .get_mut(table_id)
            .ok_or(crate::Error::TableNotFound)?;
        for update in &updates {
            table.apply_update(update.clone());
        }

        Ok(updates)
    }

    /// The current hybrid-logical-clock value. Captured in a snapshot so a
    /// later reload restores the clock and post-load writes stay ordered after
    /// the loaded history.
    pub fn timestamp_counter(&self) -> u64 {
        self.timestamp_counter
    }

    /// Every winning cell across user-data tables plus the system tables
    /// (schema + views), for a workspace snapshot. Replaying these via
    /// [`apply_update`](Self::apply_update) reconstructs the full workspace —
    /// values are LWW so order doesn't matter.
    pub fn export_cells(&self) -> Vec<Cell> {
        let mut cells = Vec::new();
        for table in self.tables.values() {
            cells.extend(table.export_cells());
        }
        cells.extend(self.schema_manager.export_cells());
        cells.extend(self.view_manager.export_cells());
        cells.extend(self.history_manager.export_cells());
        cells
    }

    /// Roll a scope back to its state at `target_server_ts` (a Matrix
    /// `origin_server_ts` point) using the already-fetched timeline `events`.
    /// Emits the batched `cell.update`s that restore the differences (fresh HLC
    /// timestamps → they LWW-win) and records the revert as a row in the
    /// `_history` table (the user-facing "rollback message"). All returned
    /// updates are applied locally already; the caller sends them over Matrix.
    /// Returns empty (and records nothing) if the scope already matches the
    /// target point — a revert to "now" is a no-op, not a history entry.
    ///
    /// `scope` is a `table_id`, or `None` for the whole workspace. `revert`
    /// supplies the record's id/actor/scope/label — the caller mints the id.
    pub fn build_rollback(
        &mut self,
        events: &[CellUpdate],
        target_server_ts: u64,
        scope: Option<&str>,
        revert: RevertRecord,
    ) -> Vec<CellUpdate> {
        // Current materialized state is authoritative (it includes local writes
        // that may not have echoed back through `events` yet).
        let current: HashMap<CellId, Cell> = self
            .export_cells()
            .into_iter()
            .map(|c| (c.id.clone(), c))
            .collect();
        let as_of = crate::history::state_as_of(events, target_server_ts);

        let base_ts = self.next_timestamp();
        // Scope predicate: the target table's data cells, PLUS its `_schema` rows
        // (row_id "<table>.<col>") and its `_tables` registry row — so a rollback
        // also reverts column/table deletions, bringing back data that a
        // `deleted_at` cutoff was hiding ("stale before the reversion, live
        // after"). A whole-workspace rollback (scope None) reverts everything
        // except the revert log itself (never rewind the history of reverts).
        let restores = crate::history::rollback_updates(
            &current,
            &as_of,
            |id: &CellId| match scope {
                Some(t) => {
                    id.table_id == t
                        || (id.table_id == crate::schema::SCHEMA_TABLE_ID
                            && id.row_id.starts_with(&format!("{t}.")))
                        || (id.table_id == crate::schema::TABLES_TABLE_ID && id.row_id == t)
                }
                None => id.table_id != crate::history::HISTORY_TABLE_ID,
            },
            base_ts,
        );
        if restores.is_empty() {
            return Vec::new();
        }
        // Apply restores locally (routes to the user tables and advances the HLC
        // past them, so the revert-row timestamps below can't collide).
        for update in &restores {
            let _ = self.apply_update(update.clone());
        }

        let hist_ts = self.next_timestamp();
        let history = self.history_manager.record_revert(&revert, hist_ts);

        let mut all = restores;
        all.extend(history);
        all
    }

    /// All recorded reverts (rows in the `_history` table), for the history UI.
    pub fn history_reverts(&self) -> Vec<RevertRecord> {
        self.history_manager.list_reverts()
    }

    /// Rebuild workspace state from a snapshot's cells (replayed through
    /// [`apply_update`](Self::apply_update), so routing/lazy-table-creation is
    /// identical to live history) and restore the logical clock. Used by the
    /// incremental cold start to avoid re-paginating full room history.
    pub fn load_cells(&mut self, cells: Vec<Cell>, timestamp_counter: u64) {
        for cell in cells {
            let _ = self.apply_update(CellUpdate::from_cell(cell));
        }
        // apply_update already advanced the clock past every cell timestamp;
        // also honor the snapshot's recorded counter (it may sit above the max
        // cell ts after local writes) so new local writes win LWW.
        self.timestamp_counter = self.timestamp_counter.max(timestamp_counter);
    }

    /// Apply a cell update (from network or local)
    pub fn apply_update(&mut self, update: CellUpdate) -> Result<()> {
        // Advance the hybrid logical clock from every observed update so that
        // subsequent local writes are ordered after replayed/remote history.
        self.observe_timestamp(update.timestamp);

        let table_id = update.table_id.clone();

        // Route to appropriate table
        if let Some(table) = self.tables.get_mut(&table_id) {
            table.apply_update(update);
        } else if table_id == crate::schema::TABLES_TABLE_ID
            || table_id == crate::schema::SCHEMA_TABLE_ID
        {
            // System table update for schema — when we see a _tables row, ensure
            // the corresponding user-data table exists in self.tables.
            if table_id == crate::schema::TABLES_TABLE_ID {
                let user_table_id = update.row_id.clone();
                self.tables
                    .entry(user_table_id.clone())
                    .or_insert_with(|| Table::new(&user_table_id));
            }
            self.schema_manager.apply_updates(vec![update]);
        } else if table_id == crate::schema::VIEWS_TABLE_ID {
            self.view_manager.apply_updates(vec![update]);
        } else if table_id == crate::history::HISTORY_TABLE_ID {
            self.history_manager.apply_updates(vec![update]);
        } else {
            // Unknown table — might be a user-data table we haven't seen a
            // _tables entry for yet (out-of-order replay). Create it lazily.
            let table = self
                .tables
                .entry(table_id)
                .or_insert_with(|| Table::new(&update.table_id));
            table.apply_update(update);
        }

        Ok(())
    }

    /// Get a table by ID
    pub fn get_table(&self, table_id: &str) -> Option<&Table> {
        self.tables.get(table_id)
    }

    /// Get a mutable reference to a table
    pub fn get_table_mut(&mut self, table_id: &str) -> Option<&mut Table> {
        self.tables.get_mut(table_id)
    }

    /// List all (non-deleted) tables in the workspace, sorted by their manual
    /// ordering key (tables with a key first, in key order, ties by id; unkeyed
    /// tables after, by id) — mirrors row ordering. Deleted tables are hidden
    /// (their tombstone lives on the `_tables` registry row); a stray data cell
    /// for a deleted table can't resurrect it here since the deleted flag is
    /// read from the registry, not from `self.tables`.
    pub fn list_tables(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .tables
            .keys()
            .filter(|id| !self.schema_manager.is_table_deleted(id))
            .cloned()
            .collect();
        ids.sort_by(|a, b| {
            match (
                self.schema_manager.table_order(a),
                self.schema_manager.table_order(b),
            ) {
                (Some(ka), Some(kb)) => ka.cmp(&kb).then_with(|| a.cmp(b)),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => a.cmp(b),
            }
        });
        ids
    }

    /// Get the schema for a table
    pub fn get_table_schema(&self, table_id: &str) -> Option<TableDefinition> {
        self.schema_manager.get_table_schema(table_id)
    }

    /// Get a view configuration
    pub fn get_view(&self, view_id: &str) -> Option<ViewConfig> {
        self.view_manager.get_view(view_id)
    }

    /// List all views for a table
    pub fn list_views_for_table(&self, table_id: &str) -> Vec<String> {
        self.view_manager.list_views_for_table(table_id)
    }

    /// Delete a row by writing a row-level **tombstone** cell.
    ///
    /// Rather than dropping the row from local memory, this writes a normal LWW
    /// `CellUpdate` (`_deleted = true`) — applied locally *and* returned so the
    /// caller can sync it to Matrix. Deletion is therefore durable: it survives
    /// a cold-start replay (the tombstone replays from the timeline and hides
    /// the row) and propagates to other devices like any other cell. The row's
    /// data cells are left in place and decay naturally. See
    /// [`tables_over_matrix::ROW_DELETED_COLUMN`] for the conflict semantics.
    pub fn delete_row(&mut self, table_id: &str, row_id: &str) -> Result<Vec<CellUpdate>> {
        if !self.tables.contains_key(table_id) {
            return Err(crate::Error::TableNotFound);
        }

        let timestamp = self.next_timestamp();
        let tombstone = CellUpdate::new(
            table_id,
            row_id,
            ROW_DELETED_COLUMN,
            serde_json::json!(true),
            timestamp,
        );

        // Apply locally so our materialized table matches what we send.
        let table = self
            .tables
            .get_mut(table_id)
            .ok_or(crate::Error::TableNotFound)?;
        table.apply_update(tombstone.clone());

        #[cfg(not(target_arch = "wasm32"))]
        info!("Tombstoned row: {} in table: {}", row_id, table_id);

        Ok(vec![tombstone])
    }

    /// Get all rows from a table as JSON.
    ///
    /// Applies per-column "cleared at" cutoffs from the schema so that values
    /// written at/before a column's deletion don't resurface if the column id is
    /// later re-created (the data cells aren't tombstoned under the decay model,
    /// so they're filtered at read time).
    pub fn get_table_rows(
        &self,
        table_id: &str,
    ) -> Result<Vec<indexmap::IndexMap<String, serde_json::Value>>> {
        let mut rows = self.raw_table_rows(table_id)?;
        // Read-time defaults (issue b4b9c90f): an empty cell in a select column
        // that has a default reads AS the default. Existing entries pick a new
        // default up without a mass write; `update_column` materializes the old
        // default before a CHANGE so those rows don't retroactively flip.
        if let Some(schema) = self.schema_manager.get_table_schema(table_id) {
            let defaults: Vec<(String, serde_json::Value)> = schema
                .columns
                .values()
                .filter(|c| matches!(c.column_type, crate::ColumnType::Select))
                .filter_map(|c| {
                    c.default_value
                        .clone()
                        .filter(|v| !value_is_empty(v))
                        .map(|v| (c.id.clone(), v))
                })
                .collect();
            if !defaults.is_empty() {
                for row in &mut rows {
                    for (col_id, default) in &defaults {
                        if row.get(col_id).is_none_or(value_is_empty) {
                            row.insert(col_id.clone(), default.clone());
                        }
                    }
                }
            }
        }
        Ok(rows)
    }

    /// Materialized rows WITHOUT read-time defaults applied — the storage
    /// truth, used internally where "is this cell actually empty" matters.
    fn raw_table_rows(
        &self,
        table_id: &str,
    ) -> Result<Vec<indexmap::IndexMap<String, serde_json::Value>>> {
        let cutoffs = self.effective_cutoffs(table_id);
        let floor = self.schema_manager.table_deleted_at(table_id).unwrap_or(0);
        let table = self
            .tables
            .get(table_id)
            .ok_or(crate::Error::TableNotFound)?;
        let mut rows = table.get_all_rows_excluding_stale(&cutoffs);
        if floor > 0 {
            // The table was deleted at `floor` (and likely re-created): drop any
            // row whose every cell predates the deletion, so old rows don't
            // reappear as empty rows. Rows added after re-create (with a cell
            // newer than `floor`) survive. See `Table::row_has_cell_newer_than`.
            rows.retain(|row| {
                row.get("_row_id")
                    .and_then(|v| v.as_str())
                    .map(|rid| table.row_has_cell_newer_than(rid, floor))
                    .unwrap_or(true)
            });
        }
        Ok(rows)
    }

    /// Map of `row_id -> manual-ordering key` for rows that have one. The
    /// `_order` key is stripped from materialized rows (it's control metadata),
    /// so the UI reads it here to compute fractional-index keys when
    /// drag-reordering.
    pub fn get_row_order_keys(&self, table_id: &str) -> Result<Vec<(String, String)>> {
        let table = self
            .tables
            .get(table_id)
            .ok_or(crate::Error::TableNotFound)?;
        Ok(table
            .rows()
            .into_iter()
            .filter_map(|id| table.row_order(&id).map(|key| (id, key)))
            .collect())
    }

    /// Delete a table by tombstoning its `_tables` registry row (decay model,
    /// mirrors [`delete_row`](Self::delete_row)). Returns the CellUpdates to
    /// sync. The table's data cells are left in place and decay; re-creating the
    /// id starts blank (the `deleted_at` cutoff hides the old rows). A deleted
    /// table is hidden by [`list_tables`](Self::list_tables) and has no schema.
    pub fn delete_table(&mut self, table_id: &str) -> Result<Vec<CellUpdate>> {
        if !self.tables.contains_key(table_id)
            && self.schema_manager.get_table_schema(table_id).is_none()
        {
            return Err(crate::Error::TableNotFound);
        }
        let timestamp = self.next_timestamp();
        let updates = self.schema_manager.delete_table(table_id, timestamp);

        #[cfg(not(target_arch = "wasm32"))]
        info!("Tombstoned table: {}", table_id);

        Ok(updates)
    }

    /// Set a table's manual-ordering key (a fractional-index string). The UI
    /// computes the key (`ui/src/fractionalIndex.ts`, same as row reorder) and
    /// calls this for each moved table. Returns the CellUpdate to sync.
    pub fn set_table_order(&mut self, table_id: &str, order_key: &str) -> Result<Vec<CellUpdate>> {
        if !self.tables.contains_key(table_id) {
            return Err(crate::Error::TableNotFound);
        }
        let timestamp = self.next_timestamp();
        Ok(self
            .schema_manager
            .set_table_order(table_id, order_key, timestamp))
    }

    /// Map of `table_id -> manual-ordering key` for (non-deleted) tables that
    /// have one (mirrors [`get_row_order_keys`](Self::get_row_order_keys)); the
    /// UI reads it to compute fractional keys when drag-reordering the table list.
    pub fn get_table_order_keys(&self) -> Vec<(String, String)> {
        self.list_tables()
            .into_iter()
            .filter_map(|id| self.schema_manager.table_order(&id).map(|key| (id, key)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{ColumnDefinition, ColumnType};
    use crate::views::{ViewConfig, ViewType};
    use serde_json::json;

    /// Exotic rollback: data hidden by a column's `deleted_at` cutoff ("stale")
    /// BEFORE the reversion becomes live AFTER — because a table rollback also
    /// reverts the table's `_schema` rows, un-deleting the column and clearing
    /// the cutoff. End-to-end through the materialized `get_table_rows`.
    #[test]
    fn build_rollback_undeletes_a_column_so_stale_data_returns() {
        fn record(events: &mut Vec<CellUpdate>, updates: Vec<CellUpdate>, server_ts: u64) {
            for u in updates {
                events.push(u.with_server_timestamp(server_ts));
            }
        }

        let mut ws = Workspace::new("test");
        let mut events: Vec<CellUpdate> = Vec::new();

        // Phase 1 (server_ts 100): table + `title` column + a data cell.
        let created = ws
            .create_table(
                TableDefinition::new("tasks", "Tasks").with_column(ColumnDefinition::new(
                    "title",
                    "Title",
                    ColumnType::Text,
                )),
            )
            .unwrap();
        record(&mut events, created, 100);
        let wrote = ws
            .update_cell_with_bump("tasks", "r1", "title", json!("hello"))
            .unwrap();
        record(&mut events, wrote, 100);

        let rows = ws.get_table_rows("tasks").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("title"), Some(&json!("hello")));

        // Phase 2 (server_ts 200): delete the column → it leaves the live schema
        // and its `deleted_at` cutoff hides the data ("stale").
        let deleted = ws.delete_column("tasks", "title").unwrap();
        record(&mut events, deleted, 200);
        assert!(
            !ws.get_table_schema("tasks")
                .unwrap()
                .columns
                .contains_key("title"),
            "column is deleted (data stale) before the reversion"
        );

        // Roll the table back to a point BEFORE the deletion (server_ts 150).
        let out = ws.build_rollback(
            &events,
            150,
            Some("tasks"),
            RevertRecord {
                id: "rev-1".into(),
                actor: "@a:b".into(),
                target: 150,
                scope: "tasks".into(),
                label: None,
            },
        );
        assert!(
            !out.is_empty(),
            "the un-delete must produce restoring updates"
        );

        // The column is live again AND the previously-stale data is back.
        assert!(
            ws.get_table_schema("tasks")
                .unwrap()
                .columns
                .contains_key("title"),
            "column un-deleted after the reversion"
        );
        let after = ws.get_table_rows("tasks").unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(
            after[0].get("title"),
            Some(&json!("hello")),
            "data that was stale before the reversion is live after"
        );
    }

    #[test]
    fn test_workspace_creation() {
        let workspace = Workspace::new("test-workspace");
        assert_eq!(workspace.id, "test-workspace");
        assert!(workspace.list_tables().is_empty());
    }

    #[test]
    fn test_create_table() {
        let mut workspace = Workspace::new("test-workspace");

        let definition = TableDefinition::new("tasks", "Tasks")
            .with_column(ColumnDefinition::new("title", "Title", ColumnType::Text))
            .with_column(ColumnDefinition::new(
                "status",
                "Status",
                ColumnType::Select,
            ));

        let updates = workspace.create_table(definition).unwrap();
        assert!(!updates.is_empty());

        let tables = workspace.list_tables();
        assert!(tables.contains(&"tasks".to_string()));
    }

    // ─── Select defaults (issue b4b9c90f) ───────────────────────────────────

    /// Workspace with a select `status` column (options open/closed, no default
    /// yet) and three rows: one set to "closed", one empty-string, one missing.
    fn select_default_fixture() -> Workspace {
        let mut ws = Workspace::new("w");
        ws.create_table(
            TableDefinition::new("t", "T")
                .with_column(ColumnDefinition::new("title", "Title", ColumnType::Text))
                .with_column(
                    ColumnDefinition::new("status", "Status", ColumnType::Select)
                        .with_options(vec!["open".into(), "closed".into()]),
                ),
        )
        .unwrap();
        ws.update_cell("t", "r1", "title", serde_json::json!("a"))
            .unwrap();
        ws.update_cell("t", "r1", "status", serde_json::json!("closed"))
            .unwrap();
        ws.update_cell("t", "r2", "title", serde_json::json!("b"))
            .unwrap();
        ws.update_cell("t", "r2", "status", serde_json::json!(""))
            .unwrap();
        ws.update_cell("t", "r3", "title", serde_json::json!("c"))
            .unwrap();
        ws
    }

    fn status_of(ws: &Workspace, row: &str) -> Option<String> {
        ws.get_table_rows("t")
            .unwrap()
            .iter()
            .find(|r| r.get("_row_id").and_then(|v| v.as_str()) == Some(row))
            .and_then(|r| r.get("status"))
            .and_then(|v| v.as_str())
            .map(String::from)
    }

    #[test]
    fn test_select_default_applies_to_existing_empty_cells_at_read_time() {
        let mut ws = select_default_fixture();
        // Setting the FIRST default writes no data cells…
        let updates = ws
            .update_column("t", "status", &serde_json::json!({"default_value": "open"}))
            .unwrap();
        assert!(
            updates
                .iter()
                .all(|u| u.table_id == crate::schema::SCHEMA_TABLE_ID),
            "first default must be schema-only, no mass write"
        );
        // …but empty (missing or "") cells now read as it; set cells don't.
        assert_eq!(status_of(&ws, "r1").as_deref(), Some("closed"));
        assert_eq!(status_of(&ws, "r2").as_deref(), Some("open"));
        assert_eq!(status_of(&ws, "r3").as_deref(), Some("open"));
    }

    #[test]
    fn test_select_default_change_materializes_old_default() {
        let mut ws = select_default_fixture();
        ws.update_column("t", "status", &serde_json::json!({"default_value": "open"}))
            .unwrap();
        // Changing open→closed: the rows that read "open" must keep it.
        let updates = ws
            .update_column(
                "t",
                "status",
                &serde_json::json!({"default_value": "closed"}),
            )
            .unwrap();
        let data_writes: Vec<_> = updates.iter().filter(|u| u.table_id == "t").collect();
        assert_eq!(
            data_writes.len(),
            2,
            "both empty cells materialize the old default"
        );
        assert!(data_writes
            .iter()
            .all(|u| u.value == serde_json::json!("open")));
        assert_eq!(status_of(&ws, "r2").as_deref(), Some("open"));
        assert_eq!(status_of(&ws, "r3").as_deref(), Some("open"));
        // A NEW empty row reads the new default.
        ws.update_cell("t", "r4", "title", serde_json::json!("d"))
            .unwrap();
        assert_eq!(status_of(&ws, "r4").as_deref(), Some("closed"));
    }

    #[test]
    fn test_text_column_default_not_substituted_at_read_time() {
        let mut ws = select_default_fixture();
        ws.update_column(
            "t",
            "title",
            &serde_json::json!({"default_value": "untitled"}),
        )
        .unwrap();
        // Read-time substitution is select-only (the issue's scope).
        let rows = ws.get_table_rows("t").unwrap();
        let r3 = rows
            .iter()
            .find(|r| r.get("_row_id").and_then(|v| v.as_str()) == Some("r3"))
            .unwrap();
        assert_eq!(r3.get("title"), Some(&serde_json::json!("c")));
    }

    #[test]
    fn test_create_table_rejects_duplicate_id() {
        let mut workspace = Workspace::new("test-workspace");
        let def = || {
            TableDefinition::new("tasks", "Tasks").with_column(ColumnDefinition::new(
                "title",
                "Title",
                ColumnType::Text,
            ))
        };
        workspace.create_table(def()).unwrap();
        // A second table with the same id must be rejected, not merged.
        assert!(matches!(
            workspace.create_table(def()),
            Err(crate::Error::TableAlreadyExists)
        ));
    }

    #[test]
    fn test_recreated_column_does_not_resurrect_old_values() {
        let mut ws = Workspace::new("w");
        ws.create_table(
            TableDefinition::new("tasks", "Tasks").with_column(ColumnDefinition::new(
                "assignee",
                "Assignee",
                ColumnType::Text,
            )),
        )
        .unwrap();
        ws.update_cell("tasks", "r1", "assignee", json!("Alice"))
            .unwrap();
        assert_eq!(
            ws.get_table_rows("tasks").unwrap()[0].get("assignee"),
            Some(&json!("Alice"))
        );

        // Delete the column, then re-create the same id.
        ws.delete_column("tasks", "assignee").unwrap();
        ws.add_column(
            "tasks",
            ColumnDefinition::new("assignee", "Assignee", ColumnType::Text),
        )
        .unwrap();

        // The pre-deletion value must NOT resurface in the re-created column.
        let rows = ws.get_table_rows("tasks").unwrap();
        let r1 = rows
            .iter()
            .find(|r| r.get("_row_id") == Some(&json!("r1")))
            .unwrap();
        assert_eq!(r1.get("assignee"), None, "old value must not resurrect");

        // A value written after re-creation IS shown.
        ws.update_cell("tasks", "r1", "assignee", json!("Bob"))
            .unwrap();
        let rows = ws.get_table_rows("tasks").unwrap();
        let r1 = rows
            .iter()
            .find(|r| r.get("_row_id") == Some(&json!("r1")))
            .unwrap();
        assert_eq!(r1.get("assignee"), Some(&json!("Bob")));
    }

    #[test]
    fn test_update_cell() {
        let mut workspace = Workspace::new("test-workspace");

        // Create a table first
        let definition = TableDefinition::new("tasks", "Tasks").with_column(ColumnDefinition::new(
            "title",
            "Title",
            ColumnType::Text,
        ));

        workspace.create_table(definition).unwrap();

        // Update a cell
        workspace
            .update_cell("tasks", "row1", "title", json!("My Task"))
            .unwrap();

        // Verify the value
        let table = workspace.get_table("tasks").unwrap();
        assert_eq!(table.get_value("row1", "title"), Some(&json!("My Task")));
    }

    #[test]
    fn test_delete_row() {
        let mut workspace = Workspace::new("test-workspace");

        let definition = TableDefinition::new("tasks", "Tasks").with_column(ColumnDefinition::new(
            "title",
            "Title",
            ColumnType::Text,
        ));

        workspace.create_table(definition).unwrap();

        workspace
            .update_cell("tasks", "row1", "title", json!("Task 1"))
            .unwrap();

        workspace
            .update_cell("tasks", "row2", "title", json!("Task 2"))
            .unwrap();

        // Delete row1 — returns the tombstone update(s) to sync.
        let updates = workspace.delete_row("tasks", "row1").unwrap();
        assert!(updates
            .iter()
            .any(|u| u.row_id == "row1" && u.column_id == ROW_DELETED_COLUMN));

        // The deleted row drops out of the materialized view; the other remains.
        let rows = workspace.get_table_rows("tasks").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("_row_id"), Some(&json!("row2")));
    }

    #[test]
    fn test_delete_row_tombstone_hides_row_on_replay() {
        // delete_row emits a tombstone CellUpdate; replaying it into another
        // workspace (a cold-start reload or a second device that already synced
        // the row) hides the row there too. This is the regression guard for
        // "deleted rows resurrect on reload".
        let mut source = Workspace::new("src");
        let def = TableDefinition::new("tasks", "Tasks").with_column(ColumnDefinition::new(
            "title",
            "Title",
            ColumnType::Text,
        ));
        source.create_table(def).unwrap();
        source
            .update_cell("tasks", "r1", "title", json!("Keep"))
            .unwrap();
        source
            .update_cell("tasks", "r2", "title", json!("Doomed"))
            .unwrap();

        let tombstone = source.delete_row("tasks", "r2").unwrap();
        assert_eq!(source.get_table_rows("tasks").unwrap().len(), 1);

        // Replica already materialized both rows; now it receives the tombstone.
        let mut replica = Workspace::new("replica");
        replica
            .apply_update(CellUpdate::new("tasks", "r1", "title", json!("Keep"), 1))
            .unwrap();
        replica
            .apply_update(CellUpdate::new("tasks", "r2", "title", json!("Doomed"), 2))
            .unwrap();
        assert_eq!(replica.get_table_rows("tasks").unwrap().len(), 2);

        for u in tombstone {
            replica.apply_update(u).unwrap();
        }
        let rows = replica.get_table_rows("tasks").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows.iter().all(|r| r.get("_row_id") != Some(&json!("r2"))));
    }

    #[test]
    fn test_realistic_project_management_workflow() {
        let mut workspace = Workspace::new("project-workspace");

        // Create a projects table with multiple columns
        let projects_def = TableDefinition::new("projects", "Projects")
            .with_column(ColumnDefinition::new(
                "name",
                "Project Name",
                ColumnType::Text,
            ))
            .with_column(ColumnDefinition::new(
                "status",
                "Status",
                ColumnType::Select,
            ))
            .with_column(ColumnDefinition::new(
                "budget",
                "Budget",
                ColumnType::Number,
            ))
            .with_column(ColumnDefinition::new(
                "active",
                "Active",
                ColumnType::Boolean,
            ));

        workspace.create_table(projects_def).unwrap();

        // Create a tasks table
        let tasks_def = TableDefinition::new("tasks", "Tasks")
            .with_column(ColumnDefinition::new("title", "Title", ColumnType::Text))
            .with_column(ColumnDefinition::new(
                "assignee",
                "Assignee",
                ColumnType::Text,
            ))
            .with_column(ColumnDefinition::new(
                "priority",
                "Priority",
                ColumnType::Number,
            ))
            .with_column(ColumnDefinition::new(
                "completed",
                "Completed",
                ColumnType::Boolean,
            ));

        workspace.create_table(tasks_def).unwrap();

        // Verify both tables exist
        let tables = workspace.list_tables();
        assert_eq!(tables.len(), 2);
        assert!(tables.contains(&"projects".to_string()));
        assert!(tables.contains(&"tasks".to_string()));

        // Add data to projects
        workspace
            .update_cell("projects", "p1", "name", json!("Website Redesign"))
            .unwrap();
        workspace
            .update_cell("projects", "p1", "status", json!("in_progress"))
            .unwrap();
        workspace
            .update_cell("projects", "p1", "budget", json!(50000))
            .unwrap();
        workspace
            .update_cell("projects", "p1", "active", json!(true))
            .unwrap();

        workspace
            .update_cell("projects", "p2", "name", json!("Mobile App"))
            .unwrap();
        workspace
            .update_cell("projects", "p2", "status", json!("planning"))
            .unwrap();
        workspace
            .update_cell("projects", "p2", "budget", json!(100000))
            .unwrap();
        workspace
            .update_cell("projects", "p2", "active", json!(false))
            .unwrap();

        // Add tasks
        workspace
            .update_cell("tasks", "t1", "title", json!("Design homepage"))
            .unwrap();
        workspace
            .update_cell("tasks", "t1", "assignee", json!("Alice"))
            .unwrap();
        workspace
            .update_cell("tasks", "t1", "priority", json!(1))
            .unwrap();
        workspace
            .update_cell("tasks", "t1", "completed", json!(false))
            .unwrap();

        workspace
            .update_cell("tasks", "t2", "title", json!("Setup API"))
            .unwrap();
        workspace
            .update_cell("tasks", "t2", "assignee", json!("Bob"))
            .unwrap();
        workspace
            .update_cell("tasks", "t2", "priority", json!(2))
            .unwrap();
        workspace
            .update_cell("tasks", "t2", "completed", json!(true))
            .unwrap();

        // Verify project data
        let projects = workspace.get_table("projects").unwrap();
        assert_eq!(projects.rows().len(), 2);
        assert_eq!(
            projects.get_value("p1", "name"),
            Some(&json!("Website Redesign"))
        );
        assert_eq!(projects.get_value("p1", "budget"), Some(&json!(50000)));
        assert_eq!(projects.get_value("p2", "active"), Some(&json!(false)));

        // Verify task data
        let tasks = workspace.get_table("tasks").unwrap();
        assert_eq!(tasks.rows().len(), 2);
        assert_eq!(tasks.get_value("t1", "assignee"), Some(&json!("Alice")));
        assert_eq!(tasks.get_value("t2", "completed"), Some(&json!(true)));

        // Update a task's status
        workspace
            .update_cell("tasks", "t1", "completed", json!(true))
            .unwrap();
        let tasks = workspace.get_table("tasks").unwrap();
        assert_eq!(tasks.get_value("t1", "completed"), Some(&json!(true)));

        // Delete a task
        workspace.delete_row("tasks", "t2").unwrap();
        let rows = workspace.get_table_rows("tasks").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows.iter().all(|r| r.get("_row_id") != Some(&json!("t2"))));
    }

    #[test]
    fn test_edge_cases() {
        let mut workspace = Workspace::new("edge-case-workspace");

        let definition = TableDefinition::new("test", "Test Table")
            .with_column(ColumnDefinition::new("text", "Text", ColumnType::Text))
            .with_column(ColumnDefinition::new(
                "number",
                "Number",
                ColumnType::Number,
            ));

        workspace.create_table(definition).unwrap();

        // Empty string
        workspace
            .update_cell("test", "r1", "text", json!(""))
            .unwrap();
        assert_eq!(
            workspace.get_table("test").unwrap().get_value("r1", "text"),
            Some(&json!(""))
        );

        // Special characters
        workspace
            .update_cell("test", "r2", "text", json!("Hello\nWorld\t\"quotes\""))
            .unwrap();
        assert_eq!(
            workspace.get_table("test").unwrap().get_value("r2", "text"),
            Some(&json!("Hello\nWorld\t\"quotes\""))
        );

        // Unicode
        workspace
            .update_cell("test", "r3", "text", json!("Hello 世界 🌍"))
            .unwrap();
        assert_eq!(
            workspace.get_table("test").unwrap().get_value("r3", "text"),
            Some(&json!("Hello 世界 🌍"))
        );

        // Zero and negative numbers
        workspace
            .update_cell("test", "r4", "number", json!(0))
            .unwrap();
        assert_eq!(
            workspace
                .get_table("test")
                .unwrap()
                .get_value("r4", "number"),
            Some(&json!(0))
        );

        workspace
            .update_cell("test", "r5", "number", json!(-999))
            .unwrap();
        assert_eq!(
            workspace
                .get_table("test")
                .unwrap()
                .get_value("r5", "number"),
            Some(&json!(-999))
        );

        // Very long string (1000 chars)
        let long_string = "a".repeat(1000);
        workspace
            .update_cell("test", "r6", "text", json!(long_string.clone()))
            .unwrap();
        assert_eq!(
            workspace.get_table("test").unwrap().get_value("r6", "text"),
            Some(&json!(long_string))
        );
    }

    #[test]
    fn test_table_not_found_error() {
        let mut workspace = Workspace::new("error-workspace");

        // Try to update cell in non-existent table
        let result = workspace.update_cell("nonexistent", "r1", "col", json!("value"));
        assert!(result.is_err());

        // Try to delete row from non-existent table
        let result = workspace.delete_row("nonexistent", "r1");
        assert!(result.is_err());

        // Try to get non-existent table
        assert!(workspace.get_table("nonexistent").is_none());
    }

    #[test]
    fn test_schema_retrieval() {
        let mut workspace = Workspace::new("schema-workspace");

        let definition = TableDefinition::new("products", "Products")
            .with_description("Product inventory")
            .with_column(ColumnDefinition::new(
                "name",
                "Product Name",
                ColumnType::Text,
            ))
            .with_column(ColumnDefinition::new("price", "Price", ColumnType::Number))
            .with_column(ColumnDefinition::new(
                "in_stock",
                "In Stock",
                ColumnType::Boolean,
            ));

        workspace.create_table(definition).unwrap();

        // Retrieve and verify schema
        let schema = workspace.get_table_schema("products").unwrap();
        assert_eq!(schema.id, "products");
        assert_eq!(schema.name, "Products");
        assert_eq!(schema.description, Some("Product inventory".to_string()));
        assert_eq!(schema.columns.len(), 3);

        // Verify columns
        let name_col = schema.columns.get("name").unwrap();
        assert_eq!(name_col.name, "Product Name");
        assert_eq!(name_col.column_type, ColumnType::Text);

        let price_col = schema.columns.get("price").unwrap();
        assert_eq!(price_col.column_type, ColumnType::Number);

        let stock_col = schema.columns.get("in_stock").unwrap();
        assert_eq!(stock_col.column_type, ColumnType::Boolean);
    }

    #[test]
    fn test_multiple_updates_same_cell() {
        let mut workspace = Workspace::new("lww-workspace");

        let definition = TableDefinition::new("counters", "Counters")
            .with_column(ColumnDefinition::new("value", "Value", ColumnType::Number));

        workspace.create_table(definition).unwrap();

        // Multiple updates to the same cell - last write wins
        workspace
            .update_cell("counters", "c1", "value", json!(1))
            .unwrap();
        workspace
            .update_cell("counters", "c1", "value", json!(2))
            .unwrap();
        workspace
            .update_cell("counters", "c1", "value", json!(3))
            .unwrap();

        let table = workspace.get_table("counters").unwrap();
        assert_eq!(table.get_value("c1", "value"), Some(&json!(3)));
    }

    #[test]
    fn test_get_all_rows() {
        let mut workspace = Workspace::new("rows-workspace");

        let definition = TableDefinition::new("users", "Users")
            .with_column(ColumnDefinition::new("name", "Name", ColumnType::Text))
            .with_column(ColumnDefinition::new("email", "Email", ColumnType::Text));

        workspace.create_table(definition).unwrap();

        // Add multiple users
        workspace
            .update_cell("users", "u1", "name", json!("Alice"))
            .unwrap();
        workspace
            .update_cell("users", "u1", "email", json!("alice@example.com"))
            .unwrap();

        workspace
            .update_cell("users", "u2", "name", json!("Bob"))
            .unwrap();
        workspace
            .update_cell("users", "u2", "email", json!("bob@example.com"))
            .unwrap();

        workspace
            .update_cell("users", "u3", "name", json!("Charlie"))
            .unwrap();
        workspace
            .update_cell("users", "u3", "email", json!("charlie@example.com"))
            .unwrap();

        // Get all rows
        let rows = workspace.get_table_rows("users").unwrap();
        assert_eq!(rows.len(), 3);

        // Verify row contents
        let alice = rows
            .iter()
            .find(|r| r.get("_row_id") == Some(&json!("u1")))
            .unwrap();
        assert_eq!(alice.get("name"), Some(&json!("Alice")));
        assert_eq!(alice.get("email"), Some(&json!("alice@example.com")));

        let bob = rows
            .iter()
            .find(|r| r.get("_row_id") == Some(&json!("u2")))
            .unwrap();
        assert_eq!(bob.get("name"), Some(&json!("Bob")));

        let charlie = rows
            .iter()
            .find(|r| r.get("_row_id") == Some(&json!("u3")))
            .unwrap();
        assert_eq!(charlie.get("email"), Some(&json!("charlie@example.com")));
    }

    // ─── View business logic ─────────────────────────────────────────────────

    fn make_tasks_def() -> TableDefinition {
        TableDefinition::new("tasks", "Tasks")
            .with_column(ColumnDefinition::new("title", "Title", ColumnType::Text))
            .with_column(ColumnDefinition::new(
                "status",
                "Status",
                ColumnType::Select,
            ))
            .with_column(ColumnDefinition::new(
                "assignee",
                "Assignee",
                ColumnType::Text,
            ))
    }

    fn make_kanban_config() -> crate::views::KanbanConfig {
        use crate::views::KanbanConfig;
        KanbanConfig {
            group_by_column: "status".to_string(),
            title_column: "title".to_string(),
            display_columns: vec![],
            column_options: vec![
                "Todo".to_string(),
                "In Progress".to_string(),
                "Done".to_string(),
            ],
            assignee_column: None,
        }
    }

    #[test]
    fn test_create_kanban_view_and_retrieve() {
        let mut workspace = Workspace::new("view-workspace");
        workspace.create_table(make_tasks_def()).unwrap();

        let config = ViewConfig::new(
            "board-1",
            "Sprint Board",
            "tasks",
            crate::views::ViewType::Kanban,
        )
        .with_kanban_config(make_kanban_config());

        workspace.create_view(config).unwrap();

        let retrieved = workspace.get_view("board-1").unwrap();
        assert_eq!(retrieved.name, "Sprint Board");
        assert_eq!(retrieved.table_id, "tasks");
        assert!(retrieved.kanban_config.is_some());
    }

    #[test]
    fn test_create_view_requires_existing_table() {
        let mut workspace = Workspace::new("view-workspace");
        // Do NOT create the table first
        let config = ViewConfig::new(
            "v1",
            "Orphan View",
            "ghost-table",
            crate::views::ViewType::Kanban,
        );
        let result = workspace.create_view(config);
        assert!(result.is_err(), "should fail when table does not exist");
    }

    #[test]
    fn test_kanban_column_options_are_persisted() {
        let mut workspace = Workspace::new("view-workspace");
        workspace.create_table(make_tasks_def()).unwrap();

        let config = ViewConfig::new("board-2", "Board", "tasks", crate::views::ViewType::Kanban)
            .with_kanban_config(make_kanban_config());

        workspace.create_view(config).unwrap();

        let retrieved = workspace.get_view("board-2").unwrap();
        let kanban = retrieved.kanban_config.unwrap();
        assert_eq!(kanban.column_options, vec!["Todo", "In Progress", "Done"]);
        assert_eq!(kanban.group_by_column, "status");
        assert_eq!(kanban.title_column, "title");
    }

    #[test]
    fn test_list_views_for_table_returns_correct_subset() {
        let mut workspace = Workspace::new("view-workspace");
        workspace.create_table(make_tasks_def()).unwrap();
        workspace
            .create_table(TableDefinition::new("projects", "Projects"))
            .unwrap();

        let tasks_view = ViewConfig::new(
            "tasks-board",
            "Task Board",
            "tasks",
            crate::views::ViewType::Kanban,
        )
        .with_kanban_config(make_kanban_config());
        let projects_view = ViewConfig::new(
            "proj-board",
            "Project Board",
            "projects",
            crate::views::ViewType::Kanban,
        )
        .with_kanban_config(make_kanban_config());

        workspace.create_view(tasks_view).unwrap();
        workspace.create_view(projects_view).unwrap();

        let task_views = workspace.list_views_for_table("tasks");
        let project_views = workspace.list_views_for_table("projects");

        assert_eq!(task_views, vec!["tasks-board"]);
        assert_eq!(project_views, vec!["proj-board"]);
    }

    #[test]
    fn test_multiple_views_for_same_table() {
        let mut workspace = Workspace::new("view-workspace");
        workspace.create_table(make_tasks_def()).unwrap();

        for i in 1..=5 {
            let id = format!("view-{}", i);
            let name = format!("Board {}", i);
            let config = ViewConfig::new(&id, &name, "tasks", crate::views::ViewType::Kanban)
                .with_kanban_config(make_kanban_config());
            workspace.create_view(config).unwrap();
        }

        let views = workspace.list_views_for_table("tasks");
        assert_eq!(views.len(), 5);
    }

    #[test]
    fn test_list_views_empty_when_no_views_created() {
        let mut workspace = Workspace::new("view-workspace");
        workspace.create_table(make_tasks_def()).unwrap();
        assert!(workspace.list_views_for_table("tasks").is_empty());
    }

    #[test]
    fn test_view_does_not_affect_table_data() {
        let mut workspace = Workspace::new("view-workspace");
        workspace.create_table(make_tasks_def()).unwrap();
        workspace
            .update_cell("tasks", "row-1", "title", json!("Build the API"))
            .unwrap();
        workspace
            .update_cell("tasks", "row-1", "status", json!("In Progress"))
            .unwrap();

        let config = ViewConfig::new("board", "Board", "tasks", crate::views::ViewType::Kanban)
            .with_kanban_config(make_kanban_config());
        workspace.create_view(config).unwrap();

        // Table data should be unchanged after view creation
        let rows = workspace.get_table_rows("tasks").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("title"), Some(&json!("Build the API")));
        assert_eq!(rows[0].get("status"), Some(&json!("In Progress")));
    }

    // ─── History replay (cold-start) tests ─────────────────────────────────

    #[test]
    fn test_replay_restores_tables() {
        // 1. Build a workspace, create a table, add data — capture all updates
        let mut source = Workspace::new("source");
        let def = make_tasks_def();
        let schema_updates = source.create_table(def).unwrap();

        source
            .update_cell("tasks", "r1", "title", json!("Fix bug"))
            .unwrap();
        source
            .update_cell("tasks", "r1", "status", json!("Todo"))
            .unwrap();
        source
            .update_cell("tasks", "r2", "title", json!("Ship feature"))
            .unwrap();

        // Manually build the user-data updates the same way ConnectedWorkspace would
        let mut all_updates: Vec<CellUpdate> = schema_updates;
        all_updates.push(CellUpdate::new(
            "tasks",
            "r1",
            "title",
            json!("Fix bug"),
            100,
        ));
        all_updates.push(CellUpdate::new("tasks", "r1", "status", json!("Todo"), 101));
        all_updates.push(CellUpdate::new(
            "tasks",
            "r2",
            "title",
            json!("Ship feature"),
            102,
        ));

        // 2. Replay on a fresh workspace
        let mut target = Workspace::new("target");
        for update in all_updates {
            target.apply_update(update).unwrap();
        }

        // 3. Verify tables exist
        assert!(target.list_tables().contains(&"tasks".to_string()));

        // 4. Verify schema was reconstructed
        let schema = target.get_table_schema("tasks").unwrap();
        assert_eq!(schema.name, "Tasks");
        assert!(schema.columns.contains_key("title"));
        assert!(schema.columns.contains_key("status"));

        // 5. Verify rows were reconstructed
        let rows = target.get_table_rows("tasks").unwrap();
        assert_eq!(rows.len(), 2);
        let r1 = rows
            .iter()
            .find(|r| r.get("_row_id") == Some(&json!("r1")))
            .unwrap();
        assert_eq!(r1.get("title"), Some(&json!("Fix bug")));
        assert_eq!(r1.get("status"), Some(&json!("Todo")));
        let r2 = rows
            .iter()
            .find(|r| r.get("_row_id") == Some(&json!("r2")))
            .unwrap();
        assert_eq!(r2.get("title"), Some(&json!("Ship feature")));
    }

    #[test]
    fn test_replay_restores_views() {
        let mut source = Workspace::new("source");
        let table_updates = source.create_table(make_tasks_def()).unwrap();
        let view_config = ViewConfig::new(
            "board-1",
            "Sprint Board",
            "tasks",
            crate::views::ViewType::Kanban,
        )
        .with_kanban_config(make_kanban_config());
        let view_updates = source.create_view(view_config).unwrap();

        // Replay all updates on a fresh workspace
        let mut target = Workspace::new("target");
        for update in table_updates.into_iter().chain(view_updates) {
            target.apply_update(update).unwrap();
        }

        // Verify table exists
        assert!(target.list_tables().contains(&"tasks".to_string()));

        // Verify view was reconstructed
        let view = target.get_view("board-1").unwrap();
        assert_eq!(view.name, "Sprint Board");
        assert_eq!(view.table_id, "tasks");
        assert!(view.kanban_config.is_some());

        let kanban = view.kanban_config.unwrap();
        assert_eq!(kanban.group_by_column, "status");
        assert_eq!(kanban.column_options, vec!["Todo", "In Progress", "Done"]);

        // Verify views are listed for the table
        let views = target.list_views_for_table("tasks");
        assert_eq!(views, vec!["board-1"]);
    }

    #[test]
    fn test_replay_handles_out_of_order_events() {
        // User-data events might arrive before schema events (out of order)
        let mut ws = Workspace::new("test");

        // Data event arrives first (before _tables entry)
        ws.apply_update(CellUpdate::new("tasks", "r1", "title", json!("First"), 50))
            .unwrap();

        // Then schema events arrive
        ws.apply_update(CellUpdate::new(
            "_tables",
            "tasks",
            "name",
            json!("Tasks"),
            1,
        ))
        .unwrap();

        // The table should exist and have the row
        assert!(ws.list_tables().contains(&"tasks".to_string()));
        let rows = ws.get_table_rows("tasks").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("title"), Some(&json!("First")));
    }

    #[test]
    fn test_replay_multiple_tables_and_views() {
        let mut source = Workspace::new("source");

        let tasks_updates = source.create_table(make_tasks_def()).unwrap();
        let projects_updates =
            source
                .create_table(
                    TableDefinition::new("projects", "Projects")
                        .with_column(ColumnDefinition::new("name", "Name", ColumnType::Text)),
                )
                .unwrap();

        let view1_updates = source
            .create_view(
                ViewConfig::new(
                    "tasks-board",
                    "Task Board",
                    "tasks",
                    crate::views::ViewType::Kanban,
                )
                .with_kanban_config(make_kanban_config()),
            )
            .unwrap();
        let view2_updates = source
            .create_view(
                ViewConfig::new(
                    "proj-board",
                    "Project Board",
                    "projects",
                    crate::views::ViewType::Kanban,
                )
                .with_kanban_config(make_kanban_config()),
            )
            .unwrap();

        // Replay
        let mut target = Workspace::new("target");
        let all = tasks_updates
            .into_iter()
            .chain(projects_updates)
            .chain(view1_updates)
            .chain(view2_updates);
        for update in all {
            target.apply_update(update).unwrap();
        }

        let tables = target.list_tables();
        assert!(tables.contains(&"tasks".to_string()));
        assert!(tables.contains(&"projects".to_string()));

        assert_eq!(target.list_views_for_table("tasks"), vec!["tasks-board"]);
        assert_eq!(target.list_views_for_table("projects"), vec!["proj-board"]);
    }

    #[test]
    fn test_moving_card_updates_status_cell() {
        // Simulates the kanban move: drag card from Todo → Done
        let mut workspace = Workspace::new("view-workspace");
        workspace.create_table(make_tasks_def()).unwrap();
        workspace
            .update_cell("tasks", "t1", "title", json!("Fix bug"))
            .unwrap();
        workspace
            .update_cell("tasks", "t1", "status", json!("Todo"))
            .unwrap();

        // The drag-end handler resolves the column and calls updateCell
        workspace
            .update_cell("tasks", "t1", "status", json!("Done"))
            .unwrap();

        let table = workspace.get_table("tasks").unwrap();
        assert_eq!(table.get_value("t1", "status"), Some(&json!("Done")));
        // Title must not be touched
        assert_eq!(table.get_value("t1", "title"), Some(&json!("Fix bug")));
    }

    // ─── Snapshot / incremental cold-start (issue 6f092cf4) ──────────────────

    /// A snapshot's exported cells, replayed into a fresh workspace, must
    /// reconstruct identical tables, rows, schema and views.
    #[test]
    fn test_snapshot_round_trip_preserves_state() {
        let mut source = Workspace::new("w");
        source.create_table(make_tasks_def()).unwrap();
        source
            .update_cell("tasks", "r1", "title", json!("Fix bug"))
            .unwrap();
        source
            .update_cell("tasks", "r1", "status", json!("Todo"))
            .unwrap();
        source
            .update_cell("tasks", "r2", "title", json!("Ship"))
            .unwrap();
        source.delete_row("tasks", "r2").unwrap();
        source
            .create_view(
                ViewConfig::new("board", "Board", "tasks", crate::views::ViewType::Kanban)
                    .with_kanban_config(make_kanban_config()),
            )
            .unwrap();

        // Snapshot → fresh workspace.
        let cells = source.export_cells();
        let counter = source.timestamp_counter();
        let mut loaded = Workspace::new("w");
        loaded.load_cells(cells, counter);

        // Tables + rows (r2 stays tombstoned) match.
        assert_eq!(
            source.get_table_rows("tasks").unwrap(),
            loaded.get_table_rows("tasks").unwrap()
        );
        let rows = loaded.get_table_rows("tasks").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("_row_id"), Some(&json!("r1")));
        // Schema + view survive.
        assert!(loaded.get_table_schema("tasks").is_some());
        assert_eq!(loaded.list_views_for_table("tasks"), vec!["board"]);
        assert!(loaded.get_view("board").unwrap().kanban_config.is_some());
    }

    /// The incremental property: snapshot + only newer events (applied in any
    /// order) converges to the same state as a full replay. A newer event wins
    /// LWW over the snapshot; an older one (already folded into the snapshot)
    /// is a harmless no-op.
    #[test]
    fn test_snapshot_plus_new_event_converges() {
        let mut source = Workspace::new("w");
        source.create_table(make_tasks_def()).unwrap();
        source
            .update_cell("tasks", "r1", "title", json!("v1"))
            .unwrap();
        let marker = source.timestamp_counter();

        // Reload from the snapshot, then apply one "new" event (ts > marker).
        let mut loaded = Workspace::new("w");
        loaded.load_cells(source.export_cells(), source.timestamp_counter());
        loaded
            .apply_update(CellUpdate::new(
                "tasks",
                "r1",
                "title",
                json!("v2"),
                marker + 5,
            ))
            .unwrap();

        assert_eq!(
            loaded.get_table("tasks").unwrap().get_value("r1", "title"),
            Some(&json!("v2")),
            "a newer-than-marker event must win over the snapshot value"
        );

        // Re-applying an event already in the snapshot (older ts) is a no-op.
        loaded
            .apply_update(CellUpdate::new("tasks", "r1", "title", json!("stale"), 1))
            .unwrap();
        assert_eq!(
            loaded.get_table("tasks").unwrap().get_value("r1", "title"),
            Some(&json!("v2"))
        );
    }

    /// After loading a snapshot, a fresh local write must out-timestamp every
    /// loaded cell (the clock is restored from the snapshot).
    #[test]
    fn test_write_after_snapshot_load_wins() {
        let mut source = Workspace::new("w");
        source.create_table(make_tasks_def()).unwrap();
        source
            .update_cell("tasks", "r1", "title", json!("loaded"))
            .unwrap();

        let mut loaded = Workspace::new("w");
        loaded.load_cells(source.export_cells(), source.timestamp_counter());
        loaded
            .update_cell("tasks", "r1", "title", json!("edited"))
            .unwrap();

        assert_eq!(
            loaded.get_table("tasks").unwrap().get_value("r1", "title"),
            Some(&json!("edited")),
            "local write after snapshot load must win (clock restored from snapshot)"
        );
    }

    // ─── Hybrid logical clock (ARCHITECTURE_REVIEW §4.1) ─────────────────────

    #[test]
    fn test_write_after_replay_wins_over_loaded_history() {
        // Reproduces the post-reload data-loss bug: after cold-start replay seeds
        // the workspace with historical cells, a fresh local edit must still win
        // LWW — even when the loaded history carries a timestamp far above the
        // current wall clock. With the old `counter += 1` clock the new edit got
        // ts=1 and lost; with the hybrid clock it is seeded from history.
        let mut ws = Workspace::new("w");
        ws.create_table(make_tasks_def()).unwrap();

        // Simulate replaying a historical event whose timestamp is far in the
        // "future" relative to the wall clock (e.g. a peer with a skewed clock).
        let huge = 9_000_000_000_000_000u64;
        ws.apply_update(CellUpdate::new("tasks", "r1", "title", json!("old"), huge))
            .unwrap();

        // A brand-new local edit must beat the loaded value.
        ws.update_cell("tasks", "r1", "title", json!("new"))
            .unwrap();

        assert_eq!(
            ws.get_table("tasks").unwrap().get_value("r1", "title"),
            Some(&json!("new")),
            "local write after replay must win LWW (clock seeded from history)"
        );
    }

    #[test]
    fn test_local_writes_are_strictly_monotonic_within_a_millisecond() {
        // Even when several writes land in the same wall-clock millisecond, each
        // must get a strictly larger timestamp so the last write wins.
        let mut ws = Workspace::new("w");
        ws.create_table(make_tasks_def()).unwrap();

        for v in ["a", "b", "c", "d"] {
            ws.update_cell("tasks", "r1", "title", json!(v)).unwrap();
        }

        assert_eq!(
            ws.get_table("tasks").unwrap().get_value("r1", "title"),
            Some(&json!("d")),
        );
    }

    // ─── Order-based bumping (ARCHITECTURE_REVIEW §4.3) ──────────────────────

    #[test]
    fn test_update_cell_with_bump_bumps_stalest_cell() {
        let mut ws = Workspace::new("w");
        ws.create_table(make_tasks_def()).unwrap();
        // Two existing cells; r1 is the stalest (written first).
        ws.update_cell("tasks", "r1", "title", json!("a")).unwrap();
        ws.update_cell("tasks", "r2", "title", json!("b")).unwrap();

        let updates = ws
            .update_cell_with_bump("tasks", "r3", "title", json!("c"))
            .unwrap();

        // user write + exactly one bump
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].row_id, "r3");
        assert_eq!(updates[0].value, json!("c"));
        // the bump re-emits the stalest cell (r1) with its current value + fresh ts
        assert_eq!(updates[1].row_id, "r1");
        assert_eq!(updates[1].value, json!("a"));
        assert!(updates[1].timestamp > updates[0].timestamp);

        // the write is materialized; the bump did not change r1's value
        let t = ws.get_table("tasks").unwrap();
        assert_eq!(t.get_value("r3", "title"), Some(&json!("c")));
        assert_eq!(t.get_value("r1", "title"), Some(&json!("a")));
    }

    #[test]
    fn test_update_cell_with_bump_no_bump_when_nothing_stale() {
        let mut ws = Workspace::new("w");
        ws.create_table(make_tasks_def()).unwrap();
        // First write into an otherwise-empty table: nothing else to bump.
        let updates = ws
            .update_cell_with_bump("tasks", "r1", "title", json!("a"))
            .unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].row_id, "r1");
    }

    #[test]
    fn test_update_cell_with_bump_rotates_through_cells() {
        // Successive writes bump different (stalest) cells, so the lookback stays
        // bounded rather than re-bumping the same cell forever.
        let mut ws = Workspace::new("w");
        ws.create_table(make_tasks_def()).unwrap();
        ws.update_cell("tasks", "r1", "title", json!("a")).unwrap();
        ws.update_cell("tasks", "r2", "title", json!("b")).unwrap();
        ws.update_cell("tasks", "r3", "title", json!("c")).unwrap();

        // First bump targets r1 (stalest)...
        let u1 = ws
            .update_cell_with_bump("tasks", "r4", "title", json!("d"))
            .unwrap();
        assert_eq!(u1[1].row_id, "r1");
        // ...and after r1 is bumped to newest, r2 becomes the stalest.
        let u2 = ws
            .update_cell_with_bump("tasks", "r5", "title", json!("e"))
            .unwrap();
        assert_eq!(u2[1].row_id, "r2");
    }

    #[test]
    fn test_update_cell_with_bump_requires_existing_table() {
        let mut ws = Workspace::new("w");
        assert!(ws
            .update_cell_with_bump("ghost", "r1", "c", json!("x"))
            .is_err());
    }

    // ── Table delete / reorder (issue c36f496d) ────────────────────────────

    fn text_table(id: &str, name: &str) -> TableDefinition {
        TableDefinition::new(id, name).with_column(ColumnDefinition::new(
            "title",
            "Title",
            ColumnType::Text,
        ))
    }

    #[test]
    fn test_delete_table_hides_from_list_and_schema() {
        let mut ws = Workspace::new("w");
        ws.create_table(text_table("a", "A")).unwrap();
        ws.create_table(text_table("b", "B")).unwrap();
        assert_eq!(ws.list_tables(), vec!["a".to_string(), "b".to_string()]);

        ws.delete_table("a").unwrap();
        assert_eq!(ws.list_tables(), vec!["b".to_string()]);
        assert!(ws.get_table_schema("a").is_none());
        assert!(ws.get_table_schema("b").is_some());

        // Deleting a non-existent table errors.
        assert!(ws.delete_table("ghost").is_err());
    }

    #[test]
    fn test_data_cell_cannot_resurrect_deleted_table_in_listing() {
        let mut ws = Workspace::new("w");
        ws.create_table(text_table("a", "A")).unwrap();
        ws.delete_table("a").unwrap();
        assert!(ws.list_tables().is_empty());

        // A late data write to the deleted table must NOT bring it back in the
        // listing — the deleted flag lives on the registry row, not the data.
        let ts = ws.next_timestamp_pub();
        ws.apply_update(CellUpdate::new("a", "r1", "title", json!("late"), ts))
            .unwrap();
        assert!(ws.list_tables().is_empty());
        assert!(ws.get_table_schema("a").is_none());
    }

    #[test]
    fn test_deleted_table_tombstone_and_cutoff_survive_replay() {
        // Build the full update stream (create → row → delete → re-create →
        // new row), then replay it into a fresh workspace exactly as cold-start
        // history would. The re-created table is listed; the pre-deletion row is
        // filtered by the table-level deleted_at cutoff; the new row survives.
        let mut src = Workspace::new("w");
        let mut stream: Vec<CellUpdate> = Vec::new();
        stream.extend(src.create_table(text_table("tasks", "Tasks")).unwrap());
        stream.extend(
            src.update_cell_with_bump("tasks", "r1", "title", json!("old row"))
                .unwrap(),
        );
        stream.extend(src.delete_table("tasks").unwrap());
        // Re-create the same id (allowed — the id is free once deleted).
        stream.extend(
            src.create_table(text_table("tasks", "Tasks Again"))
                .unwrap(),
        );
        stream.extend(
            src.update_cell_with_bump("tasks", "r2", "title", json!("new row"))
                .unwrap(),
        );

        let mut replay = Workspace::new("w");
        for u in &stream {
            let _ = replay.apply_update(u.clone());
        }

        assert_eq!(replay.list_tables(), vec!["tasks".to_string()]);
        assert!(replay.get_table_schema("tasks").is_some());
        let ids: Vec<String> = replay
            .get_table_rows("tasks")
            .unwrap()
            .into_iter()
            .filter_map(|r| {
                r.get("_row_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .collect();
        assert!(ids.contains(&"r2".to_string()), "new row present: {ids:?}");
        assert!(
            !ids.contains(&"r1".to_string()),
            "pre-deletion row must not resurrect on re-create: {ids:?}"
        );
    }

    #[test]
    fn test_reorder_tables_sorts_list() {
        let mut ws = Workspace::new("w");
        ws.create_table(text_table("a", "A")).unwrap();
        ws.create_table(text_table("b", "B")).unwrap();
        ws.create_table(text_table("c", "C")).unwrap();
        // Fractional keys placing c < a < b.
        ws.set_table_order("a", "V").unwrap();
        ws.set_table_order("b", "l").unwrap();
        ws.set_table_order("c", "G").unwrap();
        assert_eq!(
            ws.list_tables(),
            vec!["c".to_string(), "a".to_string(), "b".to_string()]
        );

        // The keys are exposed for the UI's fractional-index computation.
        let keys: HashMap<String, String> = ws.get_table_order_keys().into_iter().collect();
        assert_eq!(keys.get("c"), Some(&"G".to_string()));
    }

    #[test]
    fn test_keyed_tables_sort_before_unkeyed() {
        let mut ws = Workspace::new("w");
        ws.create_table(text_table("z", "Z")).unwrap();
        ws.create_table(text_table("a", "A")).unwrap();
        ws.create_table(text_table("m", "M")).unwrap();
        ws.set_table_order("m", "V").unwrap(); // only m is keyed
        assert_eq!(
            ws.list_tables(),
            vec!["m".to_string(), "a".to_string(), "z".to_string()]
        );
    }

    #[test]
    fn delete_view_hides_it_and_recreating_the_id_brings_it_back() {
        let mut ws = Workspace::new("w");
        let def = TableDefinition::new("tasks", "Tasks").with_column(ColumnDefinition::new(
            "title",
            "Title",
            ColumnType::Text,
        ));
        ws.create_table(def).unwrap();
        let view = ViewConfig::new("board", "Board", "tasks", ViewType::Table);
        ws.create_view(view.clone()).unwrap();
        assert_eq!(ws.list_views_for_table("tasks"), vec!["board".to_string()]);

        ws.delete_view("board").unwrap();
        assert!(
            ws.get_view("board").is_none(),
            "deleted view must not resolve"
        );
        assert!(
            ws.list_views_for_table("tasks").is_empty(),
            "deleted view must not be listed"
        );

        // Re-creating the same id clears the tombstone (LWW: the newer write).
        ws.create_view(view).unwrap();
        assert!(ws.get_view("board").is_some());
        assert_eq!(ws.list_views_for_table("tasks"), vec!["board".to_string()]);
    }

    #[test]
    fn rename_table_keeps_columns_and_rows() {
        let mut ws = Workspace::new("w");
        let def = TableDefinition::new("tasks", "Tasks").with_column(ColumnDefinition::new(
            "title",
            "Title",
            ColumnType::Text,
        ));
        ws.create_table(def).unwrap();
        ws.update_cell("tasks", "r1", "title", serde_json::json!("Ship it"))
            .unwrap();

        ws.rename_table("tasks", "Projects").unwrap();

        // Same id, new name — and nothing else moved.
        assert!(ws.list_tables().contains(&"tasks".to_string()));
        let schema = ws.get_table_schema("tasks").unwrap();
        assert_eq!(schema.name, "Projects");
        assert!(schema.columns.contains_key("title"));
        let rows = ws.get_table_rows("tasks").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], serde_json::json!("Ship it"));
    }

    #[test]
    fn renaming_an_unknown_table_is_an_error() {
        let mut ws = Workspace::new("w");
        assert!(ws.rename_table("ghost", "Nope").is_err());
    }
}
