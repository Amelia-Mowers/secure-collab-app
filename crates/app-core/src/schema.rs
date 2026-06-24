//! System table conventions and schema management.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tables_over_matrix::{CellUpdate, Table};

/// System table IDs
pub const TABLES_TABLE_ID: &str = "_tables";
pub const SCHEMA_TABLE_ID: &str = "_schema";
pub const VIEWS_TABLE_ID: &str = "_views";

/// Column data types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ColumnType {
    Text,
    Number,
    Boolean,
    Date,
    Select,
    MultiSelect,
    Reference,
    Document,
    Json,
}

/// Column definition in a schema
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnDefinition {
    pub id: String,
    pub name: String,
    pub column_type: ColumnType,
    pub required: bool,
    pub default_value: Option<Value>,
    /// For select/multiselect types
    pub options: Option<Vec<String>>,
    /// For reference type - target table ID
    pub reference_table: Option<String>,
    /// Display position. Lower sorts first; `None` (legacy columns created before
    /// ordering existed) sorts after ordered columns. Reordering rewrites these.
    #[serde(default)]
    pub order: Option<i64>,
}

impl ColumnDefinition {
    pub fn new(id: impl Into<String>, name: impl Into<String>, column_type: ColumnType) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            column_type,
            required: false,
            default_value: None,
            options: None,
            reference_table: None,
            order: None,
        }
    }

    pub fn with_order(mut self, order: i64) -> Self {
        self.order = Some(order);
        self
    }

    pub fn with_required(mut self, required: bool) -> Self {
        self.required = required;
        self
    }

    pub fn with_default(mut self, default: Value) -> Self {
        self.default_value = Some(default);
        self
    }

    pub fn with_options(mut self, options: Vec<String>) -> Self {
        self.options = Some(options);
        self
    }

    pub fn with_reference(mut self, table_id: String) -> Self {
        self.reference_table = Some(table_id);
        self
    }
}

/// Table definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDefinition {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub columns: HashMap<String, ColumnDefinition>,
    /// Ids of columns that have been deleted (decay model). They are excluded
    /// from `columns`; surfaced so the UI can also drop their lingering cell
    /// values from the grid while they age out of the timeline.
    #[serde(default)]
    pub deleted_columns: Vec<String>,
}

impl TableDefinition {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: None,
            columns: HashMap::new(),
            deleted_columns: Vec::new(),
        }
    }

    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn add_column(&mut self, column: ColumnDefinition) {
        self.columns.insert(column.id.clone(), column);
    }

    pub fn with_column(mut self, column: ColumnDefinition) -> Self {
        self.add_column(column);
        self
    }
}

/// Schema manager for handling system tables
pub struct SchemaManager {
    /// The schema table containing column definitions
    schema_table: Table,
    /// The tables table containing table definitions
    tables_table: Table,
}

impl SchemaManager {
    pub fn new() -> Self {
        Self {
            schema_table: Table::new(SCHEMA_TABLE_ID),
            tables_table: Table::new(TABLES_TABLE_ID),
        }
    }

    /// Create a new table by writing to the system tables
    /// This now applies updates immediately to avoid RefCell issues in WASM
    pub fn create_table(&mut self, definition: TableDefinition, timestamp: u64) -> Vec<CellUpdate> {
        let mut updates = Vec::new();

        // Create entry in tables table
        let table_id = definition.id.clone();
        let name_update = CellUpdate::new(
            TABLES_TABLE_ID,
            &table_id,
            "name",
            serde_json::json!(definition.name),
            timestamp,
        );
        self.tables_table.apply_update(name_update.clone());
        updates.push(name_update);

        if let Some(desc) = &definition.description {
            let desc_update = CellUpdate::new(
                TABLES_TABLE_ID,
                &table_id,
                "description",
                serde_json::json!(desc),
                timestamp + 1,
            );
            self.tables_table.apply_update(desc_update.clone());
            updates.push(desc_update);
        }

        // Create column definitions in schema table. Assign a deterministic
        // initial order (by column id) so the display position is explicit and
        // stable rather than HashMap-arbitrary; reordering overrides it later.
        let mut ts = timestamp + 2;
        let mut ordered_cols: Vec<(String, ColumnDefinition)> =
            definition.columns.into_iter().collect();
        ordered_cols.sort_by(|a, b| a.0.cmp(&b.0));
        for (idx, (col_id, column)) in ordered_cols.into_iter().enumerate() {
            // Each column is a row in the schema table
            // Row ID format: {table_id}.{column_id}
            let row_id = format!("{}.{}", table_id, col_id);

            let table_id_update = CellUpdate::new(
                SCHEMA_TABLE_ID,
                &row_id,
                "table_id",
                serde_json::json!(table_id),
                ts,
            );
            self.schema_table.apply_update(table_id_update.clone());
            updates.push(table_id_update);

            let col_id_update = CellUpdate::new(
                SCHEMA_TABLE_ID,
                &row_id,
                "column_id",
                serde_json::json!(col_id),
                ts + 1,
            );
            self.schema_table.apply_update(col_id_update.clone());
            updates.push(col_id_update);

            let name_update = CellUpdate::new(
                SCHEMA_TABLE_ID,
                &row_id,
                "name",
                serde_json::json!(column.name),
                ts + 2,
            );
            self.schema_table.apply_update(name_update.clone());
            updates.push(name_update);

            let type_update = CellUpdate::new(
                SCHEMA_TABLE_ID,
                &row_id,
                "type",
                serde_json::json!(column.column_type),
                ts + 3,
            );
            self.schema_table.apply_update(type_update.clone());
            updates.push(type_update);

            let required_update = CellUpdate::new(
                SCHEMA_TABLE_ID,
                &row_id,
                "required",
                serde_json::json!(column.required),
                ts + 4,
            );
            self.schema_table.apply_update(required_update.clone());
            updates.push(required_update);

            if let Some(default) = column.default_value {
                let default_update =
                    CellUpdate::new(SCHEMA_TABLE_ID, &row_id, "default", default, ts + 5);
                self.schema_table.apply_update(default_update.clone());
                updates.push(default_update);
            }

            if let Some(options) = column.options {
                let options_update = CellUpdate::new(
                    SCHEMA_TABLE_ID,
                    &row_id,
                    "options",
                    serde_json::json!(options),
                    ts + 6,
                );
                self.schema_table.apply_update(options_update.clone());
                updates.push(options_update);
            }

            if let Some(ref_table) = column.reference_table {
                let ref_update = CellUpdate::new(
                    SCHEMA_TABLE_ID,
                    &row_id,
                    "reference_table",
                    serde_json::json!(ref_table),
                    ts + 7,
                );
                self.schema_table.apply_update(ref_update.clone());
                updates.push(ref_update);
            }

            let order_update = CellUpdate::new(
                SCHEMA_TABLE_ID,
                &row_id,
                "order",
                serde_json::json!(column.order.unwrap_or(idx as i64)),
                ts + 8,
            );
            self.schema_table.apply_update(order_update.clone());
            updates.push(order_update);

            ts += 10;
        }

        updates
    }

    /// Get the schema for a table
    pub fn get_table_schema(&self, table_id: &str) -> Option<TableDefinition> {
        // Read from tables table
        let name = self.tables_table.get_value(table_id, "name")?;
        let description = self.tables_table.get_value(table_id, "description");

        let mut definition = TableDefinition::new(table_id, name.as_str().unwrap_or("Untitled"));

        if let Some(desc) = description {
            if let Some(desc_str) = desc.as_str() {
                definition.description = Some(desc_str.to_string());
            }
        }

        // Read columns from schema table
        for row_id in self.schema_table.rows() {
            if let Some(tid) = self.schema_table.get_value(&row_id, "table_id") {
                if tid.as_str() == Some(table_id) {
                    if let Some(column) = self.parse_column_definition(&row_id) {
                        // Deleted columns (decay model) are excluded from the live
                        // schema but reported so the UI can drop their cells too.
                        let deleted = self
                            .schema_table
                            .get_value(&row_id, "deleted")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        if deleted {
                            definition.deleted_columns.push(column.id);
                        } else {
                            definition.columns.insert(column.id.clone(), column);
                        }
                    }
                }
            }
        }

        Some(definition)
    }

    fn parse_column_definition(&self, row_id: &str) -> Option<ColumnDefinition> {
        let col_id = self.schema_table.get_value(row_id, "column_id")?.as_str()?;
        let name = self.schema_table.get_value(row_id, "name")?.as_str()?;
        let col_type: ColumnType =
            serde_json::from_value(self.schema_table.get_value(row_id, "type")?.clone()).ok()?;

        let mut column = ColumnDefinition::new(col_id, name, col_type);

        if let Some(required) = self.schema_table.get_value(row_id, "required") {
            column.required = required.as_bool().unwrap_or(false);
        }

        if let Some(default) = self.schema_table.get_value(row_id, "default") {
            column.default_value = Some(default.clone());
        }

        if let Some(options) = self.schema_table.get_value(row_id, "options") {
            column.options = serde_json::from_value(options.clone()).ok();
        }

        if let Some(ref_table) = self.schema_table.get_value(row_id, "reference_table") {
            column.reference_table = ref_table.as_str().map(String::from);
        }

        if let Some(order) = self.schema_table.get_value(row_id, "order") {
            column.order = order.as_i64();
        }

        Some(column)
    }

    /// The next order index for a new column in `table_id`: one past the current
    /// max, so added columns append rather than jump to an arbitrary position.
    fn next_column_order(&self, table_id: &str) -> i64 {
        let mut max_order: Option<i64> = None;
        for row_id in self.schema_table.rows() {
            let belongs = self
                .schema_table
                .get_value(&row_id, "table_id")
                .and_then(|v| v.as_str().map(String::from))
                == Some(table_id.to_string());
            if !belongs {
                continue;
            }
            if let Some(o) = self
                .schema_table
                .get_value(&row_id, "order")
                .and_then(|v| v.as_i64())
            {
                max_order = Some(max_order.map_or(o, |m| m.max(o)));
            }
        }
        max_order.map(|m| m + 1).unwrap_or(0)
    }

    /// Add a single column to an existing table's schema without touching data.
    /// Returns the schema CellUpdates that were applied.
    pub fn add_column(
        &mut self,
        table_id: &str,
        column: ColumnDefinition,
        timestamp: u64,
    ) -> Vec<CellUpdate> {
        let mut updates = Vec::new();
        let col_id = column.id.clone();
        let row_id = format!("{}.{}", table_id, col_id);
        let mut ts = timestamp;

        let table_id_update = CellUpdate::new(
            SCHEMA_TABLE_ID,
            &row_id,
            "table_id",
            serde_json::json!(table_id),
            ts,
        );
        self.schema_table.apply_update(table_id_update.clone());
        updates.push(table_id_update);

        let col_id_update = CellUpdate::new(
            SCHEMA_TABLE_ID,
            &row_id,
            "column_id",
            serde_json::json!(col_id),
            ts + 1,
        );
        self.schema_table.apply_update(col_id_update.clone());
        updates.push(col_id_update);

        let name_update = CellUpdate::new(
            SCHEMA_TABLE_ID,
            &row_id,
            "name",
            serde_json::json!(column.name),
            ts + 2,
        );
        self.schema_table.apply_update(name_update.clone());
        updates.push(name_update);

        let type_update = CellUpdate::new(
            SCHEMA_TABLE_ID,
            &row_id,
            "type",
            serde_json::json!(column.column_type),
            ts + 3,
        );
        self.schema_table.apply_update(type_update.clone());
        updates.push(type_update);

        let required_update = CellUpdate::new(
            SCHEMA_TABLE_ID,
            &row_id,
            "required",
            serde_json::json!(column.required),
            ts + 4,
        );
        self.schema_table.apply_update(required_update.clone());
        updates.push(required_update);

        ts += 5;

        if let Some(options) = column.options {
            let options_update = CellUpdate::new(
                SCHEMA_TABLE_ID,
                &row_id,
                "options",
                serde_json::json!(options),
                ts,
            );
            self.schema_table.apply_update(options_update.clone());
            updates.push(options_update);
            ts += 1;
        }

        if let Some(default) = column.default_value {
            let default_update = CellUpdate::new(SCHEMA_TABLE_ID, &row_id, "default", default, ts);
            self.schema_table.apply_update(default_update.clone());
            updates.push(default_update);
        }

        // Append after the current columns unless an explicit order was given.
        let order = column
            .order
            .unwrap_or_else(|| self.next_column_order(table_id));
        let order_update = CellUpdate::new(
            SCHEMA_TABLE_ID,
            &row_id,
            "order",
            serde_json::json!(order),
            timestamp + 8,
        );
        self.schema_table.apply_update(order_update.clone());
        updates.push(order_update);

        // Clear any decay tombstone: if this column id was previously deleted,
        // its schema row still carries `deleted = true`. Re-adding writes a
        // newer `deleted = false` so LWW reactivates the row — otherwise the
        // "new" column stays filtered out of the live schema (the
        // re-create-a-deleted-name no-op bug). Harmless for a never-deleted id.
        let undelete_update = CellUpdate::new(
            SCHEMA_TABLE_ID,
            &row_id,
            "deleted",
            serde_json::json!(false),
            timestamp + 9,
        );
        self.schema_table.apply_update(undelete_update.clone());
        updates.push(undelete_update);

        updates
    }

    /// Rewrite column display order: assign `0..N` to `ordered_column_ids` in the
    /// given sequence. Returns the schema CellUpdates applied.
    pub fn reorder_columns(
        &mut self,
        table_id: &str,
        ordered_column_ids: &[String],
        timestamp: u64,
    ) -> Vec<CellUpdate> {
        let mut updates = Vec::new();
        for (idx, col_id) in ordered_column_ids.iter().enumerate() {
            let row_id = format!("{table_id}.{col_id}");
            let update = CellUpdate::new(
                SCHEMA_TABLE_ID,
                &row_id,
                "order",
                serde_json::json!(idx as i64),
                timestamp + idx as u64,
            );
            self.schema_table.apply_update(update.clone());
            updates.push(update);
        }
        updates
    }

    /// Update mutable fields of an existing column. `patch` is a JSON object with
    /// any of: `name`, `column_type`, `options`, `default_value`; a schema cell is
    /// written for each present field (rename / retype / edit options / default).
    /// Returns the CellUpdates applied.
    pub fn update_column(
        &mut self,
        table_id: &str,
        column_id: &str,
        patch: &Value,
        timestamp: u64,
    ) -> Vec<CellUpdate> {
        let row_id = format!("{table_id}.{column_id}");
        let mut updates = Vec::new();
        let mut ts = timestamp;

        // (patch key → schema cell name). `column_type`/`default_value` map to the
        // cell names used by create_table (`type`/`default`).
        let mappings = [
            ("name", "name"),
            ("column_type", "type"),
            ("options", "options"),
            ("default_value", "default"),
        ];
        for (patch_key, cell) in mappings {
            if let Some(value) = patch.get(patch_key) {
                let update = CellUpdate::new(SCHEMA_TABLE_ID, &row_id, cell, value.clone(), ts);
                self.schema_table.apply_update(update.clone());
                updates.push(update);
                ts += 1;
            }
        }
        updates
    }

    /// Delete a column (decay model — architecture.md "Deletion as Natural
    /// Decay"): write a `deleted = true` marker on the column's schema row.
    /// `get_table_schema` then excludes it and reports it in `deleted_columns`;
    /// its data cells are no longer surfaced and age out of the lookback window.
    /// Returns the schema CellUpdate applied.
    pub fn delete_column(
        &mut self,
        table_id: &str,
        column_id: &str,
        timestamp: u64,
    ) -> Vec<CellUpdate> {
        let row_id = format!("{table_id}.{column_id}");
        let deleted = CellUpdate::new(
            SCHEMA_TABLE_ID,
            &row_id,
            "deleted",
            serde_json::json!(true),
            timestamp,
        );
        self.schema_table.apply_update(deleted.clone());

        // Record *when* it was deleted. If the column id is later re-created,
        // `add_column` flips `deleted` back to false but leaves `deleted_at`, and
        // row materialization uses it as a cutoff so cell values written at/before
        // the deletion don't resurrect in the new column (see
        // `column_clear_cutoffs` + `Table::get_all_rows_excluding_stale`).
        let deleted_at = CellUpdate::new(
            SCHEMA_TABLE_ID,
            &row_id,
            "deleted_at",
            serde_json::json!(timestamp),
            timestamp,
        );
        self.schema_table.apply_update(deleted_at.clone());
        vec![deleted, deleted_at]
    }

    /// Map of `column_id -> deleted_at` (the timestamp a column was last deleted)
    /// for every column in `table_id` that carries a `deleted_at` marker. Row
    /// materialization uses these as per-column cutoffs to hide cell values that
    /// predate a deletion (so a re-created column starts blank).
    pub fn column_clear_cutoffs(&self, table_id: &str) -> HashMap<String, u64> {
        let mut cutoffs = HashMap::new();
        for row_id in self.schema_table.rows() {
            if self
                .schema_table
                .get_value(&row_id, "table_id")
                .and_then(|v| v.as_str())
                != Some(table_id)
            {
                continue;
            }
            if let (Some(col_id), Some(at)) = (
                self.schema_table
                    .get_value(&row_id, "column_id")
                    .and_then(|v| v.as_str().map(String::from)),
                self.schema_table
                    .get_value(&row_id, "deleted_at")
                    .and_then(|v| v.as_u64()),
            ) {
                cutoffs.insert(col_id, at);
            }
        }
        cutoffs
    }

    /// Winning cells of the system tables (`_schema` + `_tables`) for a
    /// workspace snapshot. Replaying them via `Workspace::apply_update` routes
    /// them back to these tables and reconstructs the schema.
    pub fn export_cells(&self) -> Vec<tables_over_matrix::Cell> {
        let mut cells = self.schema_table.export_cells();
        cells.extend(self.tables_table.export_cells());
        cells
    }

    /// Apply updates to the schema system tables
    pub fn apply_updates(&mut self, updates: Vec<CellUpdate>) {
        for update in updates {
            match update.table_id.as_str() {
                SCHEMA_TABLE_ID => self.schema_table.apply_update(update),
                TABLES_TABLE_ID => self.tables_table.apply_update(update),
                _ => {} // Ignore updates to other tables
            }
        }
    }
}

impl Default for SchemaManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── TableDefinition / ColumnDefinition builders ────────────────────────

    #[test]
    fn test_create_table_definition() {
        let definition = TableDefinition::new("tasks", "Tasks")
            .with_description("Task tracking table")
            .with_column(
                ColumnDefinition::new("title", "Title", ColumnType::Text).with_required(true),
            )
            .with_column(
                ColumnDefinition::new("status", "Status", ColumnType::Select)
                    .with_options(vec!["todo".to_string(), "done".to_string()]),
            );

        assert_eq!(definition.id, "tasks");
        assert_eq!(definition.name, "Tasks");
        assert_eq!(
            definition.description,
            Some("Task tracking table".to_string())
        );
        assert_eq!(definition.columns.len(), 2);
    }

    #[test]
    fn test_column_definition_required_flag() {
        let col = ColumnDefinition::new("id", "ID", ColumnType::Text).with_required(true);
        assert!(col.required);

        let col2 = ColumnDefinition::new("notes", "Notes", ColumnType::Text);
        assert!(!col2.required);
    }

    #[test]
    fn test_column_definition_with_default_value() {
        let col = ColumnDefinition::new("priority", "Priority", ColumnType::Number)
            .with_default(serde_json::json!(1));

        assert_eq!(col.default_value, Some(serde_json::json!(1)));
    }

    #[test]
    fn test_column_definition_with_options() {
        let options = vec!["Low".to_string(), "Medium".to_string(), "High".to_string()];
        let col = ColumnDefinition::new("priority", "Priority", ColumnType::Select)
            .with_options(options.clone());

        assert_eq!(col.options, Some(options));
    }

    #[test]
    fn test_column_definition_with_reference() {
        let col = ColumnDefinition::new("project_id", "Project", ColumnType::Reference)
            .with_reference("projects".to_string());

        assert_eq!(col.reference_table, Some("projects".to_string()));
    }

    #[test]
    fn test_all_column_types_serde() {
        let types = [
            ColumnType::Text,
            ColumnType::Number,
            ColumnType::Boolean,
            ColumnType::Date,
            ColumnType::Select,
            ColumnType::MultiSelect,
            ColumnType::Reference,
            ColumnType::Document,
            ColumnType::Json,
        ];
        for ct in &types {
            let s = serde_json::to_value(ct).unwrap();
            let back: ColumnType = serde_json::from_value(s).unwrap();
            assert_eq!(&back, ct);
        }
    }

    #[test]
    fn test_table_definition_add_column_mutably() {
        let mut def = TableDefinition::new("t", "T");
        def.add_column(ColumnDefinition::new("col1", "Col 1", ColumnType::Text));
        def.add_column(ColumnDefinition::new("col2", "Col 2", ColumnType::Number));
        assert_eq!(def.columns.len(), 2);
        assert!(def.columns.contains_key("col1"));
        assert!(def.columns.contains_key("col2"));
    }

    // ─── SchemaManager ──────────────────────────────────────────────────────

    #[test]
    fn test_schema_manager_create_table() {
        let mut manager = SchemaManager::new();

        let definition = TableDefinition::new("tasks", "Tasks").with_column(ColumnDefinition::new(
            "title",
            "Title",
            ColumnType::Text,
        ));

        let updates = manager.create_table(definition, 1000);
        assert!(!updates.is_empty());

        manager.apply_updates(updates);

        let schema = manager.get_table_schema("tasks").unwrap();
        assert_eq!(schema.name, "Tasks");
        assert_eq!(schema.columns.len(), 1);
    }

    #[test]
    fn test_schema_manager_returns_none_for_unknown_table() {
        let manager = SchemaManager::new();
        assert!(manager.get_table_schema("nonexistent").is_none());
    }

    #[test]
    fn test_re_adding_a_deleted_column_reactivates_it() {
        let mut manager = SchemaManager::new();
        manager.create_table(
            TableDefinition::new("tasks", "Tasks").with_column(ColumnDefinition::new(
                "priority",
                "Priority",
                ColumnType::Text,
            )),
            1000,
        );
        assert!(manager
            .get_table_schema("tasks")
            .unwrap()
            .columns
            .contains_key("priority"));

        // Delete it (decay tombstone): excluded from live schema, reported deleted.
        manager.delete_column("tasks", "priority", 2000);
        let after_delete = manager.get_table_schema("tasks").unwrap();
        assert!(!after_delete.columns.contains_key("priority"));
        assert!(after_delete
            .deleted_columns
            .contains(&"priority".to_string()));

        // Re-add the same id → reactivated, not stuck deleted, with the new def.
        manager.add_column(
            "tasks",
            ColumnDefinition::new("priority", "Priority", ColumnType::Select)
                .with_options(vec!["Low".to_string(), "High".to_string()]),
            3000,
        );
        let after_readd = manager.get_table_schema("tasks").unwrap();
        assert!(
            after_readd.columns.contains_key("priority"),
            "re-added column should be live again"
        );
        assert!(!after_readd
            .deleted_columns
            .contains(&"priority".to_string()));
        assert_eq!(
            after_readd.columns["priority"].column_type,
            ColumnType::Select
        );
    }

    #[test]
    fn test_schema_manager_persists_description() {
        let mut manager = SchemaManager::new();

        let def = TableDefinition::new("notes", "Notes").with_description("All my notes");

        let updates = manager.create_table(def, 10);
        manager.apply_updates(updates);

        let schema = manager.get_table_schema("notes").unwrap();
        assert_eq!(schema.description, Some("All my notes".to_string()));
    }

    #[test]
    fn test_schema_manager_persists_column_options() {
        let mut manager = SchemaManager::new();

        let def = TableDefinition::new("items", "Items").with_column(
            ColumnDefinition::new("status", "Status", ColumnType::Select)
                .with_options(vec!["Open".to_string(), "Closed".to_string()]),
        );

        let updates = manager.create_table(def, 50);
        manager.apply_updates(updates);

        let schema = manager.get_table_schema("items").unwrap();
        let col = schema.columns.get("status").unwrap();
        assert_eq!(
            col.options,
            Some(vec!["Open".to_string(), "Closed".to_string()])
        );
    }

    #[test]
    fn test_schema_manager_persists_reference_column() {
        let mut manager = SchemaManager::new();

        let def = TableDefinition::new("tasks", "Tasks").with_column(
            ColumnDefinition::new("project", "Project", ColumnType::Reference)
                .with_reference("projects".to_string()),
        );

        let updates = manager.create_table(def, 80);
        manager.apply_updates(updates);

        let schema = manager.get_table_schema("tasks").unwrap();
        let col = schema.columns.get("project").unwrap();
        assert_eq!(col.reference_table, Some("projects".to_string()));
    }

    #[test]
    fn test_schema_manager_persists_required_and_default() {
        let mut manager = SchemaManager::new();

        let def = TableDefinition::new("contracts", "Contracts").with_column(
            ColumnDefinition::new("value", "Value", ColumnType::Number)
                .with_required(true)
                .with_default(serde_json::json!(0)),
        );

        let updates = manager.create_table(def, 90);
        manager.apply_updates(updates);

        let schema = manager.get_table_schema("contracts").unwrap();
        let col = schema.columns.get("value").unwrap();
        assert!(col.required);
        assert_eq!(col.default_value, Some(serde_json::json!(0)));
    }

    #[test]
    fn test_schema_manager_multiple_tables() {
        let mut manager = SchemaManager::new();

        let def_a = TableDefinition::new("a", "Table A").with_column(ColumnDefinition::new(
            "x",
            "X",
            ColumnType::Text,
        ));
        let def_b = TableDefinition::new("b", "Table B")
            .with_column(ColumnDefinition::new("y", "Y", ColumnType::Number))
            .with_column(ColumnDefinition::new("z", "Z", ColumnType::Boolean));

        let updates_a = manager.create_table(def_a, 100);
        manager.apply_updates(updates_a);
        let updates_b = manager.create_table(def_b, 200);
        manager.apply_updates(updates_b);

        let schema_a = manager.get_table_schema("a").unwrap();
        let schema_b = manager.get_table_schema("b").unwrap();

        assert_eq!(schema_a.columns.len(), 1);
        assert_eq!(schema_b.columns.len(), 2);
        assert!(schema_a.columns.contains_key("x"));
        assert!(schema_b.columns.contains_key("y"));
        assert!(schema_b.columns.contains_key("z"));
    }

    #[test]
    fn test_schema_manager_apply_updates_ignores_unrelated_tables() {
        let mut manager = SchemaManager::new();
        // Send an update for a user-space table — must be silently ignored
        let rogue = CellUpdate::new("user_data", "r1", "col", serde_json::json!("x"), 1);
        manager.apply_updates(vec![rogue]); // must not panic
        assert!(manager.get_table_schema("user_data").is_none());
    }

    #[test]
    fn test_schema_manager_full_column_set() {
        let mut manager = SchemaManager::new();

        let def = TableDefinition::new("full", "Full Table")
            .with_column(ColumnDefinition::new("t", "Text", ColumnType::Text))
            .with_column(ColumnDefinition::new("n", "Number", ColumnType::Number))
            .with_column(ColumnDefinition::new("b", "Boolean", ColumnType::Boolean))
            .with_column(ColumnDefinition::new("d", "Date", ColumnType::Date))
            .with_column(ColumnDefinition::new("s", "Select", ColumnType::Select))
            .with_column(ColumnDefinition::new(
                "m",
                "MultiSelect",
                ColumnType::MultiSelect,
            ))
            .with_column(ColumnDefinition::new(
                "r",
                "Reference",
                ColumnType::Reference,
            ))
            .with_column(ColumnDefinition::new(
                "doc",
                "Document",
                ColumnType::Document,
            ))
            .with_column(ColumnDefinition::new("j", "Json", ColumnType::Json));

        let updates = manager.create_table(def, 1);
        manager.apply_updates(updates);

        let schema = manager.get_table_schema("full").unwrap();
        assert_eq!(schema.columns.len(), 9);
        // Spot-check a few types
        assert_eq!(schema.columns["t"].column_type, ColumnType::Text);
        assert_eq!(schema.columns["b"].column_type, ColumnType::Boolean);
        assert_eq!(schema.columns["j"].column_type, ColumnType::Json);
    }
}
