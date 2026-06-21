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
        "document" | "doc" => ColumnType::Document,
        "json" => ColumnType::Json,
        other => {
            return Err(anyhow!(
                "unknown column type {other:?} \
                 (text|number|boolean|date|select|multiselect|document|json)"
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

/// Parse a `name:type[:opt1|opt2|...]` column spec into a `ColumnDefinition` at
/// the given display order. The optional 3rd segment is a `|`-separated list of
/// allowed values, valid only for `select`/`multiselect`.
fn parse_column_spec(spec: &str, order: i64) -> Result<ColumnDefinition> {
    let mut parts = spec.splitn(3, ':');
    let name = parts.next().unwrap_or("").trim();
    if name.is_empty() {
        return Err(anyhow!("empty column name in {spec:?}"));
    }
    let col_type = parse_column_type(parts.next().unwrap_or("text"))?;
    let mut col = ColumnDefinition::new(slug(name), name, col_type.clone()).with_order(order);

    if let Some(opts) = parts.next() {
        let options = parse_options(opts);
        if !options.is_empty() {
            if !matches!(col_type, ColumnType::Select | ColumnType::MultiSelect) {
                return Err(anyhow!(
                    "options only apply to select/multiselect columns (got a type with options for {name:?})"
                ));
            }
            col = col.with_options(options);
        }
    }
    Ok(col)
}

/// Split a `|`-separated options list, trimming blanks.
fn parse_options(s: &str) -> Vec<String> {
    s.split('|')
        .map(|o| o.trim().to_string())
        .filter(|o| !o.is_empty())
        .collect()
}

/// Coerce a raw string to a JSON value per the column type, **validating**
/// select/multiselect values against the column's configured options (if any).
/// Multiselect accepts a comma-separated list and stores a JSON array.
fn coerce_and_validate(column: &ColumnDefinition, raw: &str) -> Result<serde_json::Value> {
    match column.column_type {
        ColumnType::Select => {
            check_option(column, raw)?;
            Ok(serde_json::json!(raw))
        }
        ColumnType::MultiSelect => {
            let values: Vec<String> = raw
                .split(',')
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect();
            for v in &values {
                check_option(column, v)?;
            }
            Ok(serde_json::json!(values))
        }
        ref t => Ok(coerce_value(t, raw)),
    }
}

/// Reject a value that isn't among a select/multiselect column's configured
/// options. A column with no options is unconstrained (free-form).
fn check_option(column: &ColumnDefinition, value: &str) -> Result<()> {
    if let Some(opts) = &column.options {
        if !opts.is_empty() && !opts.iter().any(|o| o == value) {
            return Err(anyhow!(
                "{value:?} is not an allowed value for column {:?} (allowed: {})",
                column.name,
                opts.join(", ")
            ));
        }
    }
    Ok(())
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
        def = def.with_column(parse_column_spec(spec, i as i64)?);
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
        let value = coerce_and_validate(&schema.columns[&col_id], raw)?;
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

pub async fn column_add(workspace: String, table: String, spec: String) -> Result<()> {
    let mut client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = resolve_workspace(&client, &workspace).await?;
    let mut ws = load_workspace(&mut client, &room_id).await?;

    let table_id = resolve_table(&ws, &table)?;
    // Append after the existing columns.
    let order = ws
        .get_table_schema(&table_id)
        .map(|s| s.columns.len() as i64)
        .unwrap_or(0);
    let col = parse_column_spec(&spec, order)?;
    let col_name = col.name.clone();

    let updates = ws
        .add_column(&table_id, col)
        .map_err(|e| anyhow!("adding column: {e}"))?;
    client
        .send_cell_batch(&updates)
        .await
        .context("sending column")?;
    println!("Added column \"{col_name}\" to table {table_id}");
    Ok(())
}

pub async fn column_set(
    workspace: String,
    table: String,
    column: String,
    options: Option<String>,
    default: Option<String>,
    name: Option<String>,
) -> Result<()> {
    let mut client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = resolve_workspace(&client, &workspace).await?;
    let mut ws = load_workspace(&mut client, &room_id).await?;

    let table_id = resolve_table(&ws, &table)?;
    let schema = ws
        .get_table_schema(&table_id)
        .ok_or_else(|| anyhow!("table {table_id} has no schema"))?;
    let col_id = resolve_column(&schema, &column)?;
    let existing = &schema.columns[&col_id];

    let new_options = options.map(|s| {
        s.split(',')
            .map(|o| o.trim().to_string())
            .filter(|o| !o.is_empty())
            .collect::<Vec<_>>()
    });

    let mut patch = serde_json::Map::new();
    if let Some(opts) = &new_options {
        if !matches!(
            existing.column_type,
            ColumnType::Select | ColumnType::MultiSelect
        ) {
            return Err(anyhow!(
                "--options only applies to select/multiselect columns (column {:?} is {:?})",
                existing.name,
                existing.column_type
            ));
        }
        patch.insert("options".into(), serde_json::json!(opts));
    }
    if let Some(new_name) = name {
        patch.insert("name".into(), serde_json::json!(new_name));
    }
    if let Some(default) = default {
        // A select default must itself be an allowed option (new if given, else
        // the column's current options).
        if matches!(
            existing.column_type,
            ColumnType::Select | ColumnType::MultiSelect
        ) {
            if let Some(opts) = new_options.as_ref().or(existing.options.as_ref()) {
                if !opts.is_empty() && !opts.iter().any(|o| o == &default) {
                    return Err(anyhow!(
                        "default {default:?} is not among the allowed options ({})",
                        opts.join(", ")
                    ));
                }
            }
        }
        patch.insert(
            "default_value".into(),
            coerce_value(&existing.column_type, &default),
        );
    }

    if patch.is_empty() {
        return Err(anyhow!(
            "nothing to change — pass --options, --default, and/or --name"
        ));
    }

    let display_name = existing.name.clone();
    let updates = ws
        .update_column(&table_id, &col_id, &serde_json::Value::Object(patch))
        .map_err(|e| anyhow!("updating column: {e}"))?;
    client
        .send_cell_batch(&updates)
        .await
        .context("sending column update")?;
    println!("Updated column \"{display_name}\" ({col_id}) in table {table_id}");
    Ok(())
}
