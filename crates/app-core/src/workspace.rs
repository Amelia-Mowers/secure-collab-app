//! Workspace lifecycle and management.

use crate::schema::{SchemaManager, TableDefinition};
use crate::views::{ViewConfig, ViewManager};
use crate::Result;
use std::collections::HashMap;
use tables_over_matrix::{CellUpdate, CompactionManager, Table};
#[cfg(not(target_arch = "wasm32"))]
use tracing::info;

#[cfg(feature = "matrix")]
use tables_over_matrix::MatrixClient;

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
    /// Compaction manager for bumping
    #[allow(dead_code)]
    compaction_manager: CompactionManager,
    /// Logical timestamp counter
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
            compaction_manager: CompactionManager::new(),
            timestamp_counter: 0,
            #[cfg(feature = "matrix")]
            matrix_client: None,
            #[cfg(feature = "matrix")]
            connected: false,
        }
    }

    /// Generate the next logical timestamp
    fn next_timestamp(&mut self) -> u64 {
        self.timestamp_counter += 1;
        self.timestamp_counter
    }

    /// Public version of next_timestamp for the connected bridge.
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

    /// Apply a cell update (from network or local)
    pub fn apply_update(&mut self, update: CellUpdate) -> Result<()> {
        let table_id = update.table_id.clone();

        // Route to appropriate table
        if let Some(table) = self.tables.get_mut(&table_id) {
            table.apply_update(update);
        } else {
            // Might be a system table
            self.schema_manager.apply_updates(vec![update.clone()]);
            self.view_manager.apply_updates(vec![update]);
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

    /// List all tables in the workspace
    pub fn list_tables(&self) -> Vec<String> {
        self.tables.keys().cloned().collect()
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

    /// Delete a row from a table
    pub fn delete_row(&mut self, table_id: &str, row_id: &str) -> Result<()> {
        let table = self
            .tables
            .get_mut(table_id)
            .ok_or(crate::Error::TableNotFound)?;

        table.remove_row(row_id);
        #[cfg(not(target_arch = "wasm32"))]
        info!("Deleted row: {} from table: {}", row_id, table_id);
        Ok(())
    }

    /// Get all rows from a table as JSON
    pub fn get_table_rows(
        &self,
        table_id: &str,
    ) -> Result<Vec<indexmap::IndexMap<String, serde_json::Value>>> {
        let table = self
            .tables
            .get(table_id)
            .ok_or(crate::Error::TableNotFound)?;

        Ok(table.get_all_rows())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{ColumnDefinition, ColumnType};
    use crate::views::ViewConfig;
    use serde_json::json;

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

        // Delete row1
        workspace.delete_row("tasks", "row1").unwrap();

        let table = workspace.get_table("tasks").unwrap();
        assert_eq!(table.rows().len(), 1);
        assert!(table.get_value("row1", "title").is_none());
        assert!(table.get_value("row2", "title").is_some());
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
        let tasks = workspace.get_table("tasks").unwrap();
        assert_eq!(tasks.rows().len(), 1);
        assert!(tasks.get_value("t2", "title").is_none());
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
}
