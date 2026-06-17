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
#[wasm_bindgen]
pub struct WasmWorkspace {
    workspace: Workspace,
}

#[wasm_bindgen]
impl WasmWorkspace {
    /// Create a new workspace
    #[wasm_bindgen(constructor)]
    pub fn new(id: String) -> Self {
        Self {
            workspace: Workspace::new(id),
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
            .map_err(|_| JsValue::from_str("Failed to create table"))?;

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

    /// Delete a row from a table
    #[wasm_bindgen(js_name = deleteRow)]
    pub fn delete_row(&mut self, table_id: String, row_id: String) -> Result<(), JsValue> {
        self.workspace
            .delete_row(&table_id, &row_id)
            .map_err(|e| match e {
                crate::Error::TableNotFound => JsValue::from_str("Table not found"),
                _ => JsValue::from_str("Failed to delete row"),
            })?;

        Ok(())
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
