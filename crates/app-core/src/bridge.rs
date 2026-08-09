//! WASM bridge for JavaScript interop.

use crate::schema::TableDefinition;
use crate::views::ViewConfig;
use crate::workspace::Workspace;
use wasm_bindgen::prelude::*;

/// Initialize panic hook for better error messages in browser console
#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

/// Initialize tracing for WASM
#[wasm_bindgen]
pub fn init_tracing() {
    tracing_wasm::set_as_global_default();
}

/// WASM wrapper for Workspace
/// The identity a local (no-Matrix) workspace reports as the current user.
/// `.invalid` is reserved by RFC 2606 and can never be a real homeserver, so
/// this cannot collide with an account or be mistaken for one.
pub const LOCAL_USER_ID: &str = "@you:local.invalid";

#[wasm_bindgen]
pub struct WasmWorkspace {
    workspace: Workspace,
    /// Monotonic across every import into this workspace, so a second CSV into
    /// the same table cannot reuse the row ids the first one minted. A
    /// per-call counter would restart at zero and overwrite them.
    next_row: u64,
}

#[wasm_bindgen]
impl WasmWorkspace {
    /// Create a new workspace
    #[wasm_bindgen(constructor)]
    pub fn new(id: String) -> Self {
        Self {
            workspace: Workspace::new(id),
            next_row: 0,
        }
    }

    /// Create a table from JSON definition
    #[wasm_bindgen(js_name = createTable)]
    pub fn create_table(&mut self, definition_json: &str) -> Result<String, JsValue> {
        let definition: TableDefinition = serde_json::from_str(definition_json)
            .map_err(|_| JsValue::from_str("Invalid table definition"))?;

        let updates = self
            .workspace
            .create_table(definition)
            .map_err(|e| match e {
                crate::Error::TableAlreadyExists => {
                    JsValue::from_str("A table with that name already exists")
                }
                _ => JsValue::from_str("Failed to create table"),
            })?;

        let updates_json = serde_json::to_string(&updates)
            .map_err(|_| JsValue::from_str("Serialization failed"))?;

        Ok(updates_json)
    }

    /// Create a view from JSON configuration
    #[wasm_bindgen(js_name = createView)]
    pub fn create_view(&mut self, config_json: &str) -> Result<String, JsValue> {
        let config: ViewConfig = serde_json::from_str(config_json)
            .map_err(|_| JsValue::from_str("Invalid view config"))?;

        let updates = self.workspace.create_view(config).map_err(|e| match e {
            crate::Error::TableNotFound => JsValue::from_str("Table not found"),
            _ => JsValue::from_str("Failed to create view"),
        })?;

        let updates_json = serde_json::to_string(&updates)
            .map_err(|_| JsValue::from_str("Serialization failed"))?;

        Ok(updates_json)
    }

    /// Update a cell value
    #[wasm_bindgen(js_name = updateCell)]
    pub fn update_cell(
        &mut self,
        table_id: String,
        row_id: String,
        column_id: String,
        value_json: &str,
    ) -> Result<(), JsValue> {
        // Parse the JSON value
        let value: serde_json::Value =
            serde_json::from_str(value_json).map_err(|_| JsValue::from_str("Invalid JSON"))?;

        // Update the cell - use static error string
        self.workspace
            .update_cell(&table_id, &row_id, &column_id, value)
            .map_err(|e| match e {
                crate::Error::TableNotFound => JsValue::from_str("Table not found"),
                _ => JsValue::from_str("Update failed"),
            })?;

        Ok(())
    }

    /// Add a column to an existing table's schema
    #[wasm_bindgen(js_name = addColumn)]
    pub fn add_column(&mut self, table_id: String, column_json: &str) -> Result<(), JsValue> {
        let column: crate::schema::ColumnDefinition = serde_json::from_str(column_json)
            .map_err(|_| JsValue::from_str("Invalid column definition"))?;

        self.workspace
            .add_column(&table_id, column)
            .map_err(|e| match e {
                crate::Error::TableNotFound => JsValue::from_str("Table not found"),
                _ => JsValue::from_str("Failed to add column"),
            })?;

        Ok(())
    }

    /// Reorder a table's columns. `ordered_ids_json` is a JSON array of column
    /// ids in the new left-to-right order.
    #[wasm_bindgen(js_name = reorderColumns)]
    pub fn reorder_columns(
        &mut self,
        table_id: String,
        ordered_ids_json: &str,
    ) -> Result<(), JsValue> {
        let ordered: Vec<String> = serde_json::from_str(ordered_ids_json)
            .map_err(|_| JsValue::from_str("Invalid column id list"))?;

        self.workspace
            .reorder_columns(&table_id, &ordered)
            .map_err(|e| match e {
                crate::Error::TableNotFound => JsValue::from_str("Table not found"),
                _ => JsValue::from_str("Failed to reorder columns"),
            })?;

        Ok(())
    }

    /// Update mutable fields of a column (rename / retype / options / default).
    /// `patch_json` is a JSON object with any of `name`/`column_type`/`options`/
    /// `default_value`.
    #[wasm_bindgen(js_name = updateColumn)]
    pub fn update_column(
        &mut self,
        table_id: String,
        column_id: String,
        patch_json: &str,
    ) -> Result<(), JsValue> {
        let patch: serde_json::Value = serde_json::from_str(patch_json)
            .map_err(|_| JsValue::from_str("Invalid column patch"))?;

        self.workspace
            .update_column(&table_id, &column_id, &patch)
            .map_err(|e| match e {
                crate::Error::TableNotFound => JsValue::from_str("Table not found"),
                _ => JsValue::from_str("Failed to update column"),
            })?;

        Ok(())
    }

    /// Delete a column (decay model — marks it deleted in the schema).
    #[wasm_bindgen(js_name = deleteColumn)]
    pub fn delete_column(&mut self, table_id: String, column_id: String) -> Result<(), JsValue> {
        self.workspace
            .delete_column(&table_id, &column_id)
            .map_err(|e| match e {
                crate::Error::TableNotFound => JsValue::from_str("Table not found"),
                _ => JsValue::from_str("Failed to delete column"),
            })?;

        Ok(())
    }

    /// Apply a cell update from the network
    #[wasm_bindgen(js_name = applyUpdate)]
    pub fn apply_update(&mut self, update_json: &str) -> Result<(), JsValue> {
        let update =
            serde_json::from_str(update_json).map_err(|_| JsValue::from_str("Invalid update"))?;

        self.workspace
            .apply_update(update)
            .map_err(|_| JsValue::from_str("Failed to apply update"))?;

        Ok(())
    }

    /// Get all rows from a table as JSON
    #[wasm_bindgen(js_name = getTableRows)]
    pub fn get_table_rows(&self, table_id: String) -> Result<String, JsValue> {
        let rows = self
            .workspace
            .get_table_rows(&table_id)
            .map_err(|e| match e {
                crate::Error::TableNotFound => JsValue::from_str("Table not found"),
                _ => JsValue::from_str("Failed to get rows"),
            })?;

        let rows_json =
            serde_json::to_string(&rows).map_err(|_| JsValue::from_str("Serialization failed"))?;

        Ok(rows_json)
    }

    /// Map of `row_id -> manual-ordering key` as a JSON object.
    #[wasm_bindgen(js_name = getRowOrderKeys)]
    pub fn get_row_order_keys(&self, table_id: String) -> Result<String, JsValue> {
        let keys = self
            .workspace
            .get_row_order_keys(&table_id)
            .map_err(|_| JsValue::from_str("Table not found"))?;
        let map: std::collections::HashMap<String, String> = keys.into_iter().collect();
        serde_json::to_string(&map).map_err(|_| JsValue::from_str("Serialization failed"))
    }

    /// Get table schema as JSON
    #[wasm_bindgen(js_name = getTableSchema)]
    pub fn get_table_schema(&self, table_id: String) -> Result<String, JsValue> {
        let schema = self
            .workspace
            .get_table_schema(&table_id)
            .ok_or_else(|| JsValue::from_str("Table not found"))?;

        let schema_json = serde_json::to_string(&schema)
            .map_err(|_| JsValue::from_str("Serialization failed"))?;

        Ok(schema_json)
    }

    /// Get view configuration as JSON
    #[wasm_bindgen(js_name = getView)]
    pub fn get_view(&self, view_id: String) -> Result<String, JsValue> {
        let view = self
            .workspace
            .get_view(&view_id)
            .ok_or_else(|| JsValue::from_str("View not found"))?;

        let view_json =
            serde_json::to_string(&view).map_err(|_| JsValue::from_str("Serialization failed"))?;

        Ok(view_json)
    }

    /// List all tables
    #[wasm_bindgen(js_name = listTables)]
    pub fn list_tables(&self) -> String {
        let tables = self.workspace.list_tables();
        serde_json::to_string(&tables).unwrap_or_else(|_| "[]".to_string())
    }

    /// List views for a table
    #[wasm_bindgen(js_name = listViewsForTable)]
    pub fn list_views_for_table(&self, table_id: String) -> String {
        let views = self.workspace.list_views_for_table(&table_id);
        serde_json::to_string(&views).unwrap_or_else(|_| "[]".to_string())
    }

    /// The viewer's identity in this local workspace.
    ///
    /// A local workspace has no Matrix session and therefore no real user, but
    /// the UI asks who "me" is in two places that matter for a seeded demo:
    /// member cells render an avatar for the current user, and a view filtered
    /// to `@me` resolves against it. Without an answer, a demo's "My Board"
    /// renders empty and every assigned task shows as unassigned — the two
    /// features most worth demonstrating.
    ///
    /// So the local workspace names itself. The value is a syntactically valid
    /// MXID on a reserved-looking server so it can never collide with a real
    /// account.
    #[wasm_bindgen(js_name = currentUserId)]
    pub fn current_user_id(&self) -> String {
        LOCAL_USER_ID.to_string()
    }

    /// Import a workspace archive (the JSON file map) into this workspace.
    ///
    /// The engine is identical to the Matrix path — `apply_to_workspace` knows
    /// nothing about sessions. The difference is the tail: `ConnectedWorkspace`
    /// enqueues the resulting updates for sending, and this DISCARDS them,
    /// exactly as `deleteRow` and `deleteTable` above do. A local workspace has
    /// nowhere to send anything, which is the whole point of it.
    ///
    /// Returns `{rowsWritten, issues}`, matching the Matrix binding so the same
    /// caller can handle both.
    #[wasm_bindgen(js_name = importWorkspaceArchive)]
    pub fn import_workspace_archive(&mut self, files_json: String) -> Result<String, JsValue> {
        let files: crate::archive::Files = serde_json::from_str(&files_json)
            .map_err(|_| JsValue::from_str("Invalid archive files"))?;
        let archive = crate::archive::Archive::from_files(&files)
            .map_err(|e| JsValue::from_str(&format!("{e}")))?;
        // Row ids only have to be unique within this workspace, and a local one
        // is never merged with another, so a counter is enough — no timestamp
        // needed, which also keeps this deterministic for tests.
        let n = &mut self.next_row;
        let result = archive.apply_to_workspace(&mut self.workspace, &mut |table, row| {
            *n += 1;
            format!("row_{n}_{table}_{row}")
        });
        Ok(serde_json::json!({
            "rowsWritten": result.rows_written,
            "issues": result.issues.iter().map(|i| serde_json::json!({
                "table": i.table,
                "row": i.row,
                "column": i.column,
                "message": i.message,
            })).collect::<Vec<_>>(),
        })
        .to_string())
    }

    /// Delete a row from a table.
    ///
    /// Applies the row-level tombstone to local state. This is the local-only
    /// workspace (no Matrix), so the returned updates are not sent anywhere;
    /// the tombstone simply hides the row from `getTableRows`.
    #[wasm_bindgen(js_name = deleteRow)]
    pub fn delete_row(&mut self, table_id: String, row_id: String) -> Result<(), JsValue> {
        self.workspace
            .delete_row(&table_id, &row_id)
            .map(|_| ())
            .map_err(|e| match e {
                crate::Error::TableNotFound => JsValue::from_str("Table not found"),
                _ => JsValue::from_str("Failed to delete row"),
            })
    }

    /// Delete a table (local-only workspace). Tombstones the `_tables` registry
    /// row; the returned updates aren't synced anywhere. The table then drops
    /// out of `listTables` / `getTableSchema`.
    #[wasm_bindgen(js_name = deleteTable)]
    pub fn delete_table(&mut self, table_id: String) -> Result<(), JsValue> {
        self.workspace
            .delete_table(&table_id)
            .map(|_| ())
            .map_err(|e| match e {
                crate::Error::TableNotFound => JsValue::from_str("Table not found"),
                _ => JsValue::from_str("Failed to delete table"),
            })
    }

    /// Set a table's manual-ordering key (local-only workspace).
    #[wasm_bindgen(js_name = setTableOrder)]
    pub fn set_table_order(&mut self, table_id: String, order_key: String) -> Result<(), JsValue> {
        self.workspace
            .set_table_order(&table_id, &order_key)
            .map(|_| ())
            .map_err(|e| match e {
                crate::Error::TableNotFound => JsValue::from_str("Table not found"),
                _ => JsValue::from_str("Failed to set table order"),
            })
    }

    // ── Import / export ─────────────────────────────────────────────────────
    //
    // These four mirror `ConnectedWorkspace` name-for-name, and that is what
    // makes them visible: the Sidebar feature-detects each one
    // (`typeof workspace.exportTableCsv === 'function'`) rather than being told
    // which kind of workspace it has. Without them the demo silently rendered
    // no import or export controls at all — not disabled, absent — so a visitor
    // evaluating the product saw a version of it missing the feature that
    // answers "can I get my data in, and back out again?".
    //
    // Nothing here needs a session. CSV and archive handling is workspace-level
    // (ADR 0004); the only thing the Matrix bridge adds is sending the updates
    // afterwards, and a local workspace discards them exactly as `deleteRow`
    // and `importWorkspaceArchive` above do.

    /// Export one table as a standalone CSV: headers are column names and
    /// references render as labels, so it opens as an ordinary spreadsheet.
    #[wasm_bindgen(js_name = exportTableCsv)]
    pub fn export_table_csv(&self, table_id: String) -> Result<String, JsValue> {
        crate::archive::table_to_csv(&self.workspace, &table_id)
            .ok_or_else(|| JsValue::from_str("Table not found"))
    }

    /// Export the whole workspace as a zip — the same container the CLI reads,
    /// so a demo export opens in the real product.
    #[wasm_bindgen(js_name = exportWorkspaceZip)]
    pub fn export_workspace_zip(&self, name: String) -> Result<Vec<u8>, JsValue> {
        crate::archive::Archive::from_workspace(&self.workspace, name)
            .to_zip()
            .map_err(|e| JsValue::from_str(&format!("{e}")))
    }

    /// Inspect a CSV without importing it — see
    /// [`crate::archive::preview_csv_import`], which both bridges share.
    #[wasm_bindgen(js_name = previewCsvImport)]
    pub fn preview_csv_import(
        &self,
        table_id: String,
        csv: &str,
        sample: usize,
        overrides_json: &str,
    ) -> String {
        let overrides: Vec<crate::schema::ColumnDefinition> =
            serde_json::from_str(overrides_json).unwrap_or_default();
        crate::archive::preview_csv_import(&self.workspace, &table_id, csv, sample, &overrides)
            .to_string()
    }

    /// Import a CSV into `table_id`, creating it as `table_name` if absent and
    /// appending if not. Returns `{rowsWritten, issues}`, matching the Matrix
    /// binding so the same caller handles both.
    #[wasm_bindgen(js_name = importCsv)]
    pub fn import_csv(
        &mut self,
        table_id: String,
        table_name: String,
        csv: String,
        columns_json: String,
    ) -> Result<String, JsValue> {
        let confirmed: Vec<crate::schema::ColumnDefinition> =
            serde_json::from_str(&columns_json).unwrap_or_default();
        let table = crate::archive::csv_import_table(&table_id, &table_name, &csv, confirmed);

        let n = &mut self.next_row;
        let result = crate::archive::Archive {
            name: table_name,
            description: String::new(),
            tables: vec![table],
            views: Vec::new(),
        }
        .apply_to_workspace(&mut self.workspace, &mut |_, row| {
            *n += 1;
            format!("row_{n}_{row}")
        });

        Ok(crate::archive::import_result_json(&result).to_string())
    }

    /// Evaluate a formula against the first `limit` rows without saving it —
    /// the formula editor's live preview. Same binding on both workspaces, so
    /// the editor works in the demo too.
    #[wasm_bindgen(js_name = previewFormula)]
    pub fn preview_formula(
        &self,
        table_id: String,
        formula: String,
        limit: usize,
    ) -> Result<String, JsValue> {
        self.workspace
            .preview_formula(&table_id, &formula, limit)
            .map(|v| v.to_string())
            .map_err(|_| JsValue::from_str("Table not found"))
    }

    /// Map of `table_id -> manual-ordering key` as a JSON object.
    #[wasm_bindgen(js_name = getTableOrderKeys)]
    pub fn get_table_order_keys(&self) -> String {
        let map: std::collections::HashMap<String, String> =
            self.workspace.get_table_order_keys().into_iter().collect();
        serde_json::to_string(&map).unwrap_or_else(|_| "{}".to_string())
    }
}

// Add console_error_panic_hook dependency
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

/// Log a message to the browser console
pub fn console_log(msg: &str) {
    log(msg);
}

// WASM tests are run with wasm-pack test
