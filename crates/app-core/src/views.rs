//! View configuration and interpretation for different table projections.

use serde::{Deserialize, Serialize};
use tables_over_matrix::{CellUpdate, Table};

use crate::schema::VIEWS_TABLE_ID;

/// View types supported by the application
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ViewType {
    /// Standard data table view
    Table,
    /// Kanban board grouped by a column
    Kanban,
    /// Gallery of card tiles
    Card,
    /// Calendar indexed by a date column
    Calendar,
    /// Task list with checkboxes
    TaskList,
    /// Custom/derived view with filters
    Custom,
}

/// Sort direction for view configurations
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Ascending,
    Descending,
}

/// Sort configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SortConfig {
    pub column_id: String,
    pub direction: SortDirection,
}

/// Filter operator
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FilterOperator {
    Equals,
    NotEquals,
    Contains,
    NotContains,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
    /// Cell equals one of the values in the (array) filter value — select "is any of".
    IsAnyOf,
    /// Cell array shares at least one value with the (array) filter value — multiselect.
    HasAnyOf,
    /// Cell array contains every value in the (array) filter value — multiselect.
    HasAllOf,
    /// Cell array shares no value with the (array) filter value — multiselect.
    HasNoneOf,
    /// Date cell equals the current date at evaluation time (client-side).
    IsToday,
    IsEmpty,
    IsNotEmpty,
}

/// Filter configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterConfig {
    pub column_id: String,
    pub operator: FilterOperator,
    pub value: Option<serde_json::Value>,
}

/// Kanban-specific configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KanbanConfig {
    /// Column to group by
    pub group_by_column: String,
    /// Column to use for card title
    pub title_column: String,
    /// Optional columns to display on cards
    pub display_columns: Vec<String>,
    /// Ordered list of predefined column values (e.g. ["Todo", "In Progress", "Done"]).
    /// These columns are always shown even when empty.
    #[serde(default)]
    pub column_options: Vec<String>,
    /// Which member-type column drives the card footer person (issue bc48a6ed
    /// feedback: an explicit, OPTIONAL view setting — never inferred from the
    /// schema). Unset → no footer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee_column: Option<String>,
}

/// Calendar-specific configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarConfig {
    /// Date column to use for calendar positioning
    pub date_column: String,
    /// Column to use for event title
    pub title_column: String,
    /// Optional end date column for multi-day events
    pub end_date_column: Option<String>,
}

/// TaskList-specific configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskListConfig {
    /// Column that contains the completion status
    pub status_column: String,
    /// Value that indicates completion
    pub completed_value: serde_json::Value,
}

/// View configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewConfig {
    pub id: String,
    pub name: String,
    pub table_id: String,
    pub view_type: ViewType,
    pub sort: Vec<SortConfig>,
    pub filters: Vec<FilterConfig>,
    pub kanban_config: Option<KanbanConfig>,
    pub calendar_config: Option<CalendarConfig>,
    pub tasklist_config: Option<TaskListConfig>,
}

impl ViewConfig {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        table_id: impl Into<String>,
        view_type: ViewType,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            table_id: table_id.into(),
            view_type,
            sort: Vec::new(),
            filters: Vec::new(),
            kanban_config: None,
            calendar_config: None,
            tasklist_config: None,
        }
    }

    pub fn with_sort(mut self, column_id: impl Into<String>, direction: SortDirection) -> Self {
        self.sort.push(SortConfig {
            column_id: column_id.into(),
            direction,
        });
        self
    }

    pub fn with_filter(
        mut self,
        column_id: impl Into<String>,
        operator: FilterOperator,
        value: Option<serde_json::Value>,
    ) -> Self {
        self.filters.push(FilterConfig {
            column_id: column_id.into(),
            operator,
            value,
        });
        self
    }

    pub fn with_kanban_config(mut self, config: KanbanConfig) -> Self {
        self.kanban_config = Some(config);
        self
    }

    pub fn with_calendar_config(mut self, config: CalendarConfig) -> Self {
        self.calendar_config = Some(config);
        self
    }

    pub fn with_tasklist_config(mut self, config: TaskListConfig) -> Self {
        self.tasklist_config = Some(config);
        self
    }
}

/// View manager for handling view configurations
pub struct ViewManager {
    views_table: Table,
}

impl ViewManager {
    pub fn new() -> Self {
        Self {
            views_table: Table::new(VIEWS_TABLE_ID),
        }
    }

    /// Create a new view configuration
    pub fn create_view(&self, config: ViewConfig, timestamp: u64) -> Vec<CellUpdate> {
        let mut updates = Vec::new();
        let view_id = config.id.clone();

        // Basic view metadata
        updates.push(CellUpdate::new(
            VIEWS_TABLE_ID,
            &view_id,
            "name",
            serde_json::json!(config.name),
            timestamp,
        ));

        updates.push(CellUpdate::new(
            VIEWS_TABLE_ID,
            &view_id,
            "table_id",
            serde_json::json!(config.table_id),
            timestamp + 1,
        ));

        updates.push(CellUpdate::new(
            VIEWS_TABLE_ID,
            &view_id,
            "type",
            serde_json::json!(config.view_type),
            timestamp + 2,
        ));

        // Store configurations as JSON
        if !config.sort.is_empty() {
            updates.push(CellUpdate::new(
                VIEWS_TABLE_ID,
                &view_id,
                "sort",
                serde_json::json!(config.sort),
                timestamp + 3,
            ));
        }

        if !config.filters.is_empty() {
            updates.push(CellUpdate::new(
                VIEWS_TABLE_ID,
                &view_id,
                "filters",
                serde_json::json!(config.filters),
                timestamp + 4,
            ));
        }

        if let Some(kanban) = config.kanban_config {
            updates.push(CellUpdate::new(
                VIEWS_TABLE_ID,
                &view_id,
                "kanban_config",
                serde_json::json!(kanban),
                timestamp + 5,
            ));
        }

        if let Some(calendar) = config.calendar_config {
            updates.push(CellUpdate::new(
                VIEWS_TABLE_ID,
                &view_id,
                "calendar_config",
                serde_json::json!(calendar),
                timestamp + 6,
            ));
        }

        if let Some(tasklist) = config.tasklist_config {
            updates.push(CellUpdate::new(
                VIEWS_TABLE_ID,
                &view_id,
                "tasklist_config",
                serde_json::json!(tasklist),
                timestamp + 7,
            ));
        }

        updates
    }

    /// Get a view configuration
    pub fn get_view(&self, view_id: &str) -> Option<ViewConfig> {
        let name = self.views_table.get_value(view_id, "name")?.as_str()?;
        let table_id = self.views_table.get_value(view_id, "table_id")?.as_str()?;
        let view_type: ViewType =
            serde_json::from_value(self.views_table.get_value(view_id, "type")?.clone()).ok()?;

        let mut config = ViewConfig::new(view_id, name, table_id, view_type);

        // Parse optional configurations
        if let Some(sort_json) = self.views_table.get_value(view_id, "sort") {
            config.sort = serde_json::from_value(sort_json.clone()).unwrap_or_default();
        }

        if let Some(filters_json) = self.views_table.get_value(view_id, "filters") {
            config.filters = serde_json::from_value(filters_json.clone()).unwrap_or_default();
        }

        if let Some(kanban_json) = self.views_table.get_value(view_id, "kanban_config") {
            config.kanban_config = serde_json::from_value(kanban_json.clone()).ok();
        }

        if let Some(calendar_json) = self.views_table.get_value(view_id, "calendar_config") {
            config.calendar_config = serde_json::from_value(calendar_json.clone()).ok();
        }

        if let Some(tasklist_json) = self.views_table.get_value(view_id, "tasklist_config") {
            config.tasklist_config = serde_json::from_value(tasklist_json.clone()).ok();
        }

        Some(config)
    }

    /// List all views for a table
    pub fn list_views_for_table(&self, table_id: &str) -> Vec<String> {
        let mut view_ids = Vec::new();

        for row_id in self.views_table.rows() {
            if let Some(tid) = self.views_table.get_value(&row_id, "table_id") {
                if tid.as_str() == Some(table_id) {
                    view_ids.push(row_id);
                }
            }
        }

        view_ids
    }

    /// Winning cells of the `_views` system table for a workspace snapshot.
    pub fn export_cells(&self) -> Vec<tables_over_matrix::Cell> {
        self.views_table.export_cells()
    }

    /// Apply updates to the views table
    pub fn apply_updates(&mut self, updates: Vec<CellUpdate>) {
        for update in updates {
            if update.table_id == VIEWS_TABLE_ID {
                self.views_table.apply_update(update);
            }
        }
    }
}

impl Default for ViewManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_kanban_config() -> KanbanConfig {
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

    // ─── ViewConfig builder ──────────────────────────────────────────────────

    #[test]
    fn test_view_config_creation() {
        let config = ViewConfig::new("view1", "My Kanban", "tasks", ViewType::Kanban)
            .with_sort("priority", SortDirection::Descending)
            .with_filter(
                "status",
                FilterOperator::NotEquals,
                Some(serde_json::json!("done")),
            )
            .with_kanban_config(KanbanConfig {
                group_by_column: "status".to_string(),
                title_column: "title".to_string(),
                display_columns: vec!["assignee".to_string()],
                column_options: vec!["Todo".to_string(), "Done".to_string()],
                assignee_column: None,
            });

        assert_eq!(config.view_type, ViewType::Kanban);
        assert_eq!(config.sort.len(), 1);
        assert_eq!(config.filters.len(), 1);
        assert!(config.kanban_config.is_some());
    }

    #[test]
    fn test_view_config_sorts_accumulate() {
        let config = ViewConfig::new("v", "V", "t", ViewType::Table)
            .with_sort("name", SortDirection::Ascending)
            .with_sort("priority", SortDirection::Descending);

        assert_eq!(config.sort.len(), 2);
        assert_eq!(config.sort[0].column_id, "name");
        assert_eq!(config.sort[1].direction, SortDirection::Descending);
    }

    #[test]
    fn test_view_config_filters_accumulate() {
        let config = ViewConfig::new("v", "V", "t", ViewType::Table)
            .with_filter(
                "status",
                FilterOperator::Equals,
                Some(serde_json::json!("active")),
            )
            .with_filter(
                "score",
                FilterOperator::GreaterThan,
                Some(serde_json::json!(5)),
            );

        assert_eq!(config.filters.len(), 2);
        assert_eq!(config.filters[0].operator, FilterOperator::Equals);
        assert_eq!(config.filters[1].operator, FilterOperator::GreaterThan);
    }

    #[test]
    fn test_view_config_with_calendar_config() {
        let config = ViewConfig::new("cal", "Calendar", "events", ViewType::Calendar)
            .with_calendar_config(CalendarConfig {
                date_column: "start_date".to_string(),
                title_column: "event_name".to_string(),
                end_date_column: Some("end_date".to_string()),
            });

        assert_eq!(config.view_type, ViewType::Calendar);
        let cal = config.calendar_config.unwrap();
        assert_eq!(cal.date_column, "start_date");
        assert_eq!(cal.end_date_column, Some("end_date".to_string()));
    }

    #[test]
    fn test_view_config_with_tasklist_config() {
        let config = ViewConfig::new("tasks", "My Tasks", "todos", ViewType::TaskList)
            .with_tasklist_config(TaskListConfig {
                status_column: "done".to_string(),
                completed_value: serde_json::json!(true),
            });

        assert_eq!(config.view_type, ViewType::TaskList);
        let tl = config.tasklist_config.unwrap();
        assert_eq!(tl.status_column, "done");
        assert_eq!(tl.completed_value, serde_json::json!(true));
    }

    // ─── ViewManager ────────────────────────────────────────────────────────

    #[test]
    fn test_view_manager_create_and_retrieve() {
        let manager = ViewManager::new();

        let config = ViewConfig::new("kanban1", "Task Board", "tasks", ViewType::Kanban)
            .with_kanban_config(make_kanban_config());

        let updates = manager.create_view(config, 1000);
        assert!(!updates.is_empty());

        let mut manager = ViewManager::new();
        manager.apply_updates(updates);

        let retrieved = manager.get_view("kanban1").unwrap();
        assert_eq!(retrieved.name, "Task Board");
        assert_eq!(retrieved.table_id, "tasks");
        assert_eq!(retrieved.view_type, ViewType::Kanban);
    }

    #[test]
    fn test_view_manager_returns_none_for_missing_view() {
        let manager = ViewManager::new();
        assert!(manager.get_view("does-not-exist").is_none());
    }

    #[test]
    fn test_view_manager_list_views_for_table() {
        let mut manager = ViewManager::new();

        for (id, table) in [("v1", "tasks"), ("v2", "tasks"), ("v3", "projects")] {
            let cfg = ViewConfig::new(id, id, table, ViewType::Table);
            let updates = manager.create_view(cfg, 100);
            manager.apply_updates(updates);
        }

        let task_views = manager.list_views_for_table("tasks");
        let project_views = manager.list_views_for_table("projects");

        assert_eq!(task_views.len(), 2);
        assert!(task_views.contains(&"v1".to_string()));
        assert!(task_views.contains(&"v2".to_string()));
        assert_eq!(project_views, vec!["v3"]);
    }

    #[test]
    fn test_view_manager_list_views_empty_for_unknown_table() {
        let manager = ViewManager::new();
        assert!(manager.list_views_for_table("ghost").is_empty());
    }

    #[test]
    fn test_view_manager_sort_and_filter_round_trip() {
        let mut manager = ViewManager::new();

        let config = ViewConfig::new("filtered", "Filtered Board", "tasks", ViewType::Table)
            .with_sort("priority", SortDirection::Descending)
            .with_filter(
                "status",
                FilterOperator::NotEquals,
                Some(serde_json::json!("archived")),
            );

        let updates = manager.create_view(config, 500);
        manager.apply_updates(updates);

        let retrieved = manager.get_view("filtered").unwrap();
        assert_eq!(retrieved.sort.len(), 1);
        assert_eq!(retrieved.sort[0].column_id, "priority");
        assert_eq!(retrieved.sort[0].direction, SortDirection::Descending);
        assert_eq!(retrieved.filters.len(), 1);
        assert_eq!(retrieved.filters[0].operator, FilterOperator::NotEquals);
    }

    #[test]
    fn test_view_manager_kanban_column_options_round_trip() {
        let mut manager = ViewManager::new();

        let cfg = ViewConfig::new("board", "Board", "tasks", ViewType::Kanban)
            .with_kanban_config(make_kanban_config());

        let updates = manager.create_view(cfg, 200);
        manager.apply_updates(updates);

        let retrieved = manager.get_view("board").unwrap();
        let kanban = retrieved.kanban_config.unwrap();
        assert_eq!(kanban.column_options, vec!["Todo", "In Progress", "Done"]);
        assert_eq!(kanban.group_by_column, "status");
        assert_eq!(kanban.title_column, "title");
    }

    #[test]
    fn test_view_manager_calendar_config_round_trip() {
        let mut manager = ViewManager::new();

        let cfg = ViewConfig::new("cal", "Events", "events", ViewType::Calendar)
            .with_calendar_config(CalendarConfig {
                date_column: "event_date".to_string(),
                title_column: "title".to_string(),
                end_date_column: None,
            });

        let updates = manager.create_view(cfg, 300);
        manager.apply_updates(updates);

        let retrieved = manager.get_view("cal").unwrap();
        let cal = retrieved.calendar_config.unwrap();
        assert_eq!(cal.date_column, "event_date");
        assert_eq!(cal.title_column, "title");
        assert!(cal.end_date_column.is_none());
    }

    #[test]
    fn test_view_manager_tasklist_config_round_trip() {
        let mut manager = ViewManager::new();

        let cfg = ViewConfig::new("tl", "Todos", "todos", ViewType::TaskList).with_tasklist_config(
            TaskListConfig {
                status_column: "is_done".to_string(),
                completed_value: serde_json::json!(true),
            },
        );

        let updates = manager.create_view(cfg, 400);
        manager.apply_updates(updates);

        let retrieved = manager.get_view("tl").unwrap();
        let tl = retrieved.tasklist_config.unwrap();
        assert_eq!(tl.status_column, "is_done");
        assert_eq!(tl.completed_value, serde_json::json!(true));
    }

    #[test]
    fn test_view_manager_apply_updates_ignores_non_view_table() {
        let mut manager = ViewManager::new();
        // Push an update for a different system table — it should be silently ignored
        let rogue = tables_over_matrix::CellUpdate::new(
            "_schema",
            "row1",
            "col",
            serde_json::json!("val"),
            1,
        );
        manager.apply_updates(vec![rogue]); // must not panic
        assert!(manager.list_views_for_table("tasks").is_empty());
    }

    #[test]
    fn test_view_type_serde_roundtrip() {
        let types = [
            ViewType::Table,
            ViewType::Kanban,
            ViewType::Card,
            ViewType::Calendar,
            ViewType::TaskList,
            ViewType::Custom,
        ];
        for vt in &types {
            let serialized = serde_json::to_value(vt).unwrap();
            let back: ViewType = serde_json::from_value(serialized).unwrap();
            assert_eq!(&back, vt);
        }
    }

    #[test]
    fn test_filter_operator_serde_roundtrip() {
        let ops = [
            FilterOperator::Equals,
            FilterOperator::NotEquals,
            FilterOperator::Contains,
            FilterOperator::NotContains,
            FilterOperator::GreaterThan,
            FilterOperator::GreaterThanOrEqual,
            FilterOperator::LessThan,
            FilterOperator::LessThanOrEqual,
            FilterOperator::IsAnyOf,
            FilterOperator::HasAnyOf,
            FilterOperator::HasAllOf,
            FilterOperator::HasNoneOf,
            FilterOperator::IsToday,
            FilterOperator::IsEmpty,
            FilterOperator::IsNotEmpty,
        ];
        for op in &ops {
            let s = serde_json::to_value(op).unwrap();
            let back: FilterOperator = serde_json::from_value(s).unwrap();
            assert_eq!(&back, op);
        }
    }
}
