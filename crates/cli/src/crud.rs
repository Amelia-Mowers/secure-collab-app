//! Workspace / table / row CRUD commands.
//!
//! Each command restores the saved session, syncs once, and — for anything that
//! touches an existing workspace — cold-starts a `Workspace` from the room's
//! history (replaying every cell update through `Workspace::apply_update`, which
//! routes schema/data/view updates to the right place). Writes compute the
//! resulting cell updates locally and send them as a single batch event (one
//! Matrix event, so a multi-cell op isn't throttled by the per-message rate
//! limit).

use anyhow::{anyhow, Context, Result};
use app_core::{ColumnDefinition, ColumnType, TableDefinition, Workspace};
use tables_over_matrix::MatrixClient;

use crate::session;

// ── shared helpers ──────────────────────────────────────────────────────

/// Restore the logged-in client from `~/.tidework/`.
async fn restore_client() -> Result<MatrixClient> {
    let paths = session::Paths::resolve()?;
    let saved = paths
        .load_session()?
        .ok_or_else(|| anyhow!("Not logged in. Run `tidework login` first."))?;
    MatrixClient::restore_with_store(&saved.homeserver, &paths.store_dir, &saved.session)
        .await
        .context("restoring session")
}

/// Resolve a workspace argument — a room id (starts with `!`) or a workspace
/// name — to a room id.
async fn resolve_workspace(client: &MatrixClient, arg: &str) -> Result<String> {
    if arg.starts_with('!') {
        return Ok(arg.to_string());
    }
    let mut matches = client
        .list_workspaces()
        .await?
        .into_iter()
        .filter(|w| w.name == arg)
        .collect::<Vec<_>>();
    match matches.len() {
        0 => Err(anyhow!(
            "no workspace named {arg:?}; run `tidework workspace list` or pass a room id"
        )),
        1 => Ok(matches.remove(0).room_id),
        _ => Err(anyhow!(
            "multiple workspaces named {arg:?}; pass the room id (starts with `!`) instead"
        )),
    }
}

/// Cold-start a `Workspace` from a room's full history.
async fn load_workspace(client: &mut MatrixClient, room_id: &str) -> Result<Workspace> {
    client.set_room_from_str(room_id)?;
    let updates = client
        .load_room_cell_updates()
        .await
        .context("loading workspace history")?;
    let mut ws = Workspace::new(room_id);
    for update in updates {
        let _ = ws.apply_update(update);
    }
    Ok(ws)
}

/// Resolve a table argument — a table id or its display name — to a table id.
fn resolve_table(ws: &Workspace, arg: &str) -> Result<String> {
    let ids = ws.list_tables();
    if ids.iter().any(|id| id == arg) {
        return Ok(arg.to_string());
    }
    let mut by_name: Vec<String> = ids
        .into_iter()
        .filter(|id| ws.get_table_schema(id).is_some_and(|s| s.name == arg))
        .collect();
    match by_name.len() {
        0 => Err(anyhow!("no table named {arg:?} in this workspace")),
        1 => Ok(by_name.remove(0)),
        _ => Err(anyhow!(
            "multiple tables named {arg:?}; pass the table id instead"
        )),
    }
}

/// Resolve a column argument — a column id or its display name — to a column id.
fn resolve_column(schema: &TableDefinition, arg: &str) -> Result<String> {
    if schema.columns.contains_key(arg) {
        return Ok(arg.to_string());
    }
    let mut by_name: Vec<String> = schema
        .columns
        .values()
        .filter(|c| c.name == arg)
        .map(|c| c.id.clone())
        .collect();
    match by_name.len() {
        0 => Err(anyhow!("no column named {arg:?} in this table")),
        1 => Ok(by_name.remove(0)),
        _ => Err(anyhow!("multiple columns named {arg:?}; use the column id")),
    }
}

/// A url/id-safe slug: lowercase, runs of non-alphanumerics collapse to `_`.
fn slug(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_us = false;
    for c in s.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_us = false;
        } else if !prev_us {
            out.push('_');
            prev_us = true;
        }
    }
    out.trim_matches('_').to_string()
}

fn parse_column_type(s: &str) -> Result<ColumnType> {
    Ok(match s.trim().to_lowercase().as_str() {
        "" | "text" | "str" | "string" => ColumnType::Text,
        "number" | "num" | "int" | "float" => ColumnType::Number,
        "boolean" | "bool" => ColumnType::Boolean,
        "date" => ColumnType::Date,
        "select" => ColumnType::Select,
        "multiselect" => ColumnType::MultiSelect,
        "json" => ColumnType::Json,
        other => {
            return Err(anyhow!(
                "unknown column type {other:?} (text|number|boolean|date|select|multiselect|json)"
            ))
        }
    })
}

/// Coerce a raw string to a JSON value per the column type (best-effort: an
/// unparseable number/bool falls back to the raw string).
fn coerce_value(column_type: &ColumnType, raw: &str) -> serde_json::Value {
    match column_type {
        // Prefer an integer so whole numbers render as `2`, not `2.0`.
        ColumnType::Number => {
            let t = raw.trim();
            if let Ok(i) = t.parse::<i64>() {
                serde_json::json!(i)
            } else if let Ok(f) = t.parse::<f64>() {
                serde_json::json!(f)
            } else {
                serde_json::json!(raw)
            }
        }
        ColumnType::Boolean => match raw.trim().to_lowercase().as_str() {
            "true" | "yes" | "y" | "1" => serde_json::json!(true),
            "false" | "no" | "n" | "0" => serde_json::json!(false),
            _ => serde_json::json!(raw),
        },
        _ => serde_json::json!(raw),
    }
}

fn render_value(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Print a grid of strings with columns aligned to their widest cell.
fn print_aligned(rows: &[Vec<String>]) {
    let ncols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let mut widths = vec![0usize; ncols];
    for r in rows {
        for (i, cell) in r.iter().enumerate() {
            widths[i] = widths[i].max(cell.chars().count());
        }
    }
    for r in rows {
        let line = r
            .iter()
            .enumerate()
            .map(|(i, cell)| {
                let pad = widths[i].saturating_sub(cell.chars().count());
                format!("{cell}{}", " ".repeat(pad))
            })
            .collect::<Vec<_>>()
            .join("  ");
        println!("{}", line.trim_end());
    }
}

// ── commands ────────────────────────────────────────────────────────────

pub async fn workspace_create(name: String) -> Result<()> {
    let client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = client
        .create_workspace_room(&name)
        .await
        .context("creating workspace")?;
    println!("Created workspace \"{name}\"");
    println!("  room id: {room_id}");
    Ok(())
}

pub async fn workspace_list() -> Result<()> {
    let client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let workspaces = client.list_workspaces().await?;
    if workspaces.is_empty() {
        println!("No workspaces yet. Create one with `tidework workspace create <name>`.");
        return Ok(());
    }
    let mut grid = vec![vec!["NAME".to_string(), "ROOM ID".to_string()]];
    for w in workspaces {
        let name = if w.name.is_empty() {
            "(unnamed)".to_string()
        } else {
            w.name
        };
        grid.push(vec![name, w.room_id]);
    }
    print_aligned(&grid);
    Ok(())
}

pub async fn table_create(workspace: String, name: String, columns: Vec<String>) -> Result<()> {
    if columns.is_empty() {
        return Err(anyhow!(
            "a table needs at least one column (--columns name:type,...)"
        ));
    }
    let mut client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = resolve_workspace(&client, &workspace).await?;
    let mut ws = load_workspace(&mut client, &room_id).await?;

    let table_id = slug(&name);
    if table_id.is_empty() {
        return Err(anyhow!("table name {name:?} produced an empty id"));
    }
    let mut def = TableDefinition::new(&table_id, &name);
    for (i, spec) in columns.iter().enumerate() {
        let (col_name, type_str) = match spec.split_once(':') {
            Some((n, t)) => (n.trim(), t),
            None => (spec.trim(), "text"),
        };
        if col_name.is_empty() {
            return Err(anyhow!("empty column name in {spec:?}"));
        }
        let col_type = parse_column_type(type_str)?;
        let col = ColumnDefinition::new(slug(col_name), col_name, col_type).with_order(i as i64);
        def = def.with_column(col);
    }

    let updates = ws
        .create_table(def)
        .map_err(|e| anyhow!("creating table: {e}"))?;
    client
        .send_cell_batch(&updates)
        .await
        .context("sending table schema")?;
    println!(
        "Created table \"{name}\" (id: {table_id}) with {} column(s)",
        columns.len()
    );
    Ok(())
}

pub async fn table_list(workspace: String) -> Result<()> {
    let mut client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = resolve_workspace(&client, &workspace).await?;
    let ws = load_workspace(&mut client, &room_id).await?;

    let ids = ws.list_tables();
    if ids.is_empty() {
        println!(
            "No tables yet. Create one with `tidework table create <ws> <name> --columns ...`."
        );
        return Ok(());
    }
    let mut grid = vec![vec![
        "NAME".to_string(),
        "ID".to_string(),
        "COLUMNS".to_string(),
    ]];
    let mut ids = ids;
    ids.sort();
    for id in ids {
        match ws.get_table_schema(&id) {
            Some(schema) => grid.push(vec![schema.name, id, schema.columns.len().to_string()]),
            None => grid.push(vec!["(no schema)".to_string(), id, "0".to_string()]),
        }
    }
    print_aligned(&grid);
    Ok(())
}

pub async fn table_show(workspace: String, table: String) -> Result<()> {
    let mut client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = resolve_workspace(&client, &workspace).await?;
    let ws = load_workspace(&mut client, &room_id).await?;

    let table_id = resolve_table(&ws, &table)?;
    let schema = ws
        .get_table_schema(&table_id)
        .ok_or_else(|| anyhow!("table {table_id} has no schema"))?;

    // Columns in display order.
    let mut cols: Vec<&ColumnDefinition> = schema.columns.values().collect();
    cols.sort_by_key(|c| c.order.unwrap_or(i64::MAX));
    let col_ids: Vec<String> = cols.iter().map(|c| c.id.clone()).collect();

    let mut grid: Vec<Vec<String>> = Vec::new();
    let mut header = vec!["ROW".to_string()];
    header.extend(cols.iter().map(|c| c.name.to_uppercase()));
    grid.push(header);

    let rows = ws
        .get_table_rows(&table_id)
        .map_err(|e| anyhow!("reading rows: {e}"))?;
    for row in &rows {
        let mut line = vec![row
            .get("_row_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()];
        for cid in &col_ids {
            line.push(row.get(cid).map(render_value).unwrap_or_default());
        }
        grid.push(line);
    }

    print_aligned(&grid);
    println!("\n{} row(s)", rows.len());
    Ok(())
}

pub async fn row_add(workspace: String, table: String, cells: Vec<String>) -> Result<()> {
    if cells.is_empty() {
        return Err(anyhow!("provide at least one column=value pair"));
    }
    let mut client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = resolve_workspace(&client, &workspace).await?;
    let mut ws = load_workspace(&mut client, &room_id).await?;

    let table_id = resolve_table(&ws, &table)?;
    let schema = ws
        .get_table_schema(&table_id)
        .ok_or_else(|| anyhow!("table {table_id} has no schema"))?;

    let row_id = uuid::Uuid::new_v4().to_string();
    let mut updates = Vec::new();
    for assignment in &cells {
        let (col, raw) = assignment
            .split_once('=')
            .ok_or_else(|| anyhow!("expected column=value, got {assignment:?}"))?;
        let col_id = resolve_column(&schema, col)?;
        let col_type = &schema.columns[&col_id].column_type;
        let value = coerce_value(col_type, raw);
        updates.extend(
            ws.update_cell_with_bump(&table_id, &row_id, &col_id, value)
                .map_err(|e| anyhow!("writing cell: {e}"))?,
        );
    }

    client
        .send_cell_batch(&updates)
        .await
        .context("sending row")?;
    println!("Added row {row_id} to \"{}\"", schema.name);
    Ok(())
}
