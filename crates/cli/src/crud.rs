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
use app_core::snapshot::{WorkspaceSnapshot, SNAPSHOT_VERSION};
use app_core::{ColumnDefinition, ColumnType, TableDefinition, Workspace};
use tables_over_matrix::{CellUpdate, MatrixClient};

use crate::session;

// ── shared helpers ──────────────────────────────────────────────────────

/// Restore the logged-in client from `~/.tidework/`.
async fn restore_client() -> Result<MatrixClient> {
    let paths = session::Paths::resolve()?;
    let saved = paths
        .load_session()?
        .ok_or_else(|| anyhow!("Not logged in. Run `tidework login` first."))?;
    let client =
        MatrixClient::restore_with_store(&saved.homeserver, &paths.store_dir, &saved.session)
            .await
            .context("restoring session")?;
    // Persist rotated OAuth tokens whenever the SDK refreshes them, so the next
    // run restores a live token instead of failing `invalid_grant`. The session
    // blob is otherwise written only at login, so a rotated refresh token is
    // lost on exit.
    let homeserver = saved.homeserver.clone();
    client.persist_session_on_refresh(move |blob| {
        if let Err(e) = paths.save_session(&homeserver, &blob) {
            eprintln!("warning: could not persist refreshed session: {e}");
        }
    });
    Ok(client)
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

/// Ignore any persisted snapshot for this run, forcing a full history walk.
///
/// Set by `--cold`. It exists for measurement: cold and warm start differ only
/// in whether a snapshot is read, and the alternative way to get a cold number
/// — wiping the data directory — also throws away the Matrix store, so it
/// re-downloads keys and re-syncs room state and stops being a comparison.
/// Re-seeding a room to get one back is the expensive part.
///
/// Note what this does NOT simulate: a device that has never seen the room.
/// The Matrix store is still warm, so this isolates the cost of the history
/// walk, which is the part that grows with the workspace.
pub static COLD_START: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Load a `Workspace`, resuming from a local snapshot when there is one.
///
/// Every CLI invocation used to re-paginate the ENTIRE room and replay every
/// update. That is ~7 ms per event (ADR 0006 M1), so a workspace of any real
/// size made every single command pay minutes — and `row add` paid it to write
/// one row, which is what made scripted row-by-row work quadratic.
///
/// Now the materialized state is persisted after each load and the next run
/// fetches only what is newer than its marker. A missing, unreadable or
/// stale-versioned snapshot silently falls back to the full walk, because a
/// wrong snapshot must never be preferred to a slow correct load.
async fn load_workspace(client: &mut MatrixClient, room_id: &str) -> Result<Workspace> {
    client.set_room_from_str(room_id)?;

    let paths = session::Paths::resolve()?;
    let snapshot_path = paths.snapshot_file(room_id);
    let cold = COLD_START.load(std::sync::atomic::Ordering::Relaxed)
        || std::env::var("TIDEWORK_COLD_START").is_ok();
    let snapshot = if cold {
        None
    } else {
        std::fs::read_to_string(&snapshot_path)
            .ok()
            .and_then(|raw| WorkspaceSnapshot::from_json(&raw).ok())
            .filter(|snap| snap.is_fast_path_usable())
    };

    let mut ws = Workspace::new(room_id);
    let marker_ts = match &snapshot {
        Some(snap) => {
            // Same primitive the wasm bridge uses, so both clients rehydrate a
            // snapshot identically rather than by two similar-looking routes.
            ws.load_cells(snap.cells.clone(), snap.timestamp_counter);
            snap.marker_ts
        }
        None => 0,
    };

    // TIDEWORK_UNBOUNDED_WALK exists so the coverage stop can be measured
    // against itself on ONE room with ONE binary. Without it, "the bounded walk
    // saves X" is a comparison between two builds and two seeded rooms, which is
    // not a comparison at all.
    let bounded = std::env::var("TIDEWORK_UNBOUNDED_WALK").is_err();

    // Undecryptable history means the keys have not arrived yet, which is
    // normal for a moment after a burst of writes: megolm sessions rotate and
    // backup download is asynchronous. Materializing anyway would print a
    // workspace with holes in it and no indication of which rows are missing —
    // so wait for the keys instead, and fail rather than lie if they never
    // come. A CLI can afford to be correct and delayed; it has no way to show
    // the "still catching up" state a UI can.
    let mut attempt = 0u32;
    let (updates, newest_ts, stats) = loop {
        let (u, ts, st) = client
            .load_room_cell_updates_bounded(marker_ts, bounded)
            .await
            .context("loading workspace history")?;
        if st.undecryptable == 0 || attempt >= 5 {
            if st.undecryptable > 0 {
                return Err(anyhow!(
                    "{} events in this workspace could not be decrypted after {}                      attempts — the keys have not reached this device. Wait and                      retry; if it persists, the history may need recovering from                      backup.",
                    st.undecryptable,
                    attempt + 1
                ));
            }
            break (u, ts, st);
        }
        // 1s, 2s, 4s, 8s, 16s — long enough to cover key delivery, short
        // enough that an interactive command does not appear hung.
        let wait = 1u64 << attempt;
        eprintln!(
            "{} events not yet decryptable; waiting {wait}s for keys",
            st.undecryptable
        );
        tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
        let _ = client.sync_once().await;
        attempt += 1;
    };
    if std::env::var("TIDEWORK_WALK_STATS").is_ok() {
        eprintln!(
            "walk: {} events, {} page(s), {} cells, stopped: {}",
            stats.events, stats.pages, stats.cells, stats.stopped
        );
    }
    for update in updates {
        let _ = ws.apply_update(update);
    }

    // Persist for the next run. Best-effort: a workspace that loaded correctly
    // must not fail a command because a cache could not be written.
    let snap = WorkspaceSnapshot {
        version: SNAPSHOT_VERSION,
        marker_ts: newest_ts,
        timestamp_counter: ws.timestamp_counter(),
        undecryptable_count: 0,
        cells: ws.export_cells(),
    };
    if let (Some(dir), Ok(json)) = (snapshot_path.parent(), snap.to_json()) {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(&snapshot_path, json);
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
        "member" => ColumnType::Member,
        "members" | "multimember" => ColumnType::MultiMember,
        "reference" | "ref" => ColumnType::Reference,
        "references" | "multireference" => ColumnType::MultiReference,
        "formula" => ColumnType::Formula,
        other => {
            return Err(anyhow!(
                "unknown column type {other:?} \
                 (text|number|boolean|date|select|multiselect|document|json|\
                 member|members|reference|references|formula)"
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

    let tail = parts.next();

    // A formula takes the whole remainder verbatim — `splitn(3, …)` leaves it
    // intact, so an expression may contain colons.
    if matches!(col_type, ColumnType::Formula) {
        let formula = tail.unwrap_or("").trim();
        if formula.is_empty() {
            return Err(anyhow!(
                "formula column {name:?} needs an expression, e.g. \
                 {name:?}:formula:join(\" \", First Name, Last Name)"
            ));
        }
        return Ok(col.with_formula(formula));
    }

    if let Some(opts) = tail {
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
        ColumnType::MultiMember | ColumnType::MultiReference => {
            let values: Vec<String> = raw
                .split(',')
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect();
            Ok(serde_json::json!(values))
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
        // Computed at read time from the row's other cells — there is nothing
        // to write to, and a stored value would be silently ignored.
        ColumnType::Formula => Err(anyhow!(
            "column {:?} is a formula: its value is computed, not set",
            column.name
        )),
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

pub async fn table_show(
    workspace: String,
    table: String,
    filters: Vec<String>,
    sorts: Vec<String>,
    view: Option<String>,
) -> Result<()> {
    let mut client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = resolve_workspace(&client, &workspace).await?;
    let ws = load_workspace(&mut client, &room_id).await?;

    let table_id = resolve_table(&ws, &table)?;
    let schema = ws
        .get_table_schema(&table_id)
        .ok_or_else(|| anyhow!("table {table_id} has no schema"))?;

    let view_config = view.map(|v| resolve_view(&ws, &table_id, &v)).transpose()?;

    // Columns in display order.
    let mut cols: Vec<&ColumnDefinition> = schema.columns.values().collect();
    cols.sort_by_key(|c| c.order.unwrap_or(i64::MAX));
    let col_ids: Vec<String> = cols.iter().map(|c| c.id.clone()).collect();

    // Parse the query, resolving column names against this table's schema.
    let predicates = filters
        .iter()
        .map(|f| parse_predicate(&schema, f))
        .collect::<Result<Vec<_>>>()?;
    let sort_keys = sorts
        .iter()
        .map(|s| parse_sort_key(&schema, s))
        .collect::<Result<Vec<_>>>()?;

    let mut rows = ws
        .get_table_rows(&table_id)
        .map_err(|e| anyhow!("reading rows: {e}"))?;
    let total = rows.len();

    // The saved view's filters apply first (same engine as the app), then any
    // ad-hoc --where on top (AND). An explicit --sort overrides the view's sort.
    if let Some(vc) = &view_config {
        // Dynamic filter values resolve against THIS caller: `is_today` against
        // the local date, `@me` against the logged-in MXID — so a shared "mine"
        // view selects the right rows for whoever runs it.
        let ctx = app_core::filter_eval::FilterContext::new(
            chrono::Local::now().format("%Y-%m-%d").to_string(),
        )
        .with_me(client.user_id());
        rows.retain(|row| app_core::filter_eval::row_matches(row, &vc.filters, &schema, &ctx));
    }
    rows.retain(|row| predicates.iter().all(|p| p.matches(row)));
    if !sort_keys.is_empty() {
        rows.sort_by(|a, b| compare_by_keys(a, b, &sort_keys));
    } else if let Some(vc) = &view_config {
        app_core::filter_eval::sort_rows(&mut rows, &vc.sort, &schema);
    }
    let shown = rows.len();

    let mut grid: Vec<Vec<String>> = Vec::new();
    let mut header = vec!["ROW".to_string()];
    header.extend(cols.iter().map(|c| c.name.to_uppercase()));
    grid.push(header);
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
    let via = view_config
        .map(|vc| format!(", view \"{}\"", vc.name))
        .unwrap_or_default();
    if shown == total {
        println!("\n{shown} row(s){via}");
    } else {
        println!("\n{shown} of {total} row(s){via}");
    }
    Ok(())
}

/// Resolve a view argument — a view id or its display name — to its config,
/// scoped to one table's views.
fn resolve_view(ws: &Workspace, table_id: &str, arg: &str) -> Result<app_core::ViewConfig> {
    let configs: Vec<app_core::ViewConfig> = ws
        .list_views_for_table(table_id)
        .iter()
        .filter_map(|id| ws.get_view(id))
        .collect();
    if let Some(vc) = configs.iter().find(|v| v.id == arg) {
        return Ok(vc.clone());
    }
    let mut by_name: Vec<&app_core::ViewConfig> =
        configs.iter().filter(|v| v.name == arg).collect();
    match by_name.len() {
        1 => Ok(by_name.remove(0).clone()),
        0 => {
            let available = configs
                .iter()
                .map(|v| format!("{:?}", v.name))
                .collect::<Vec<_>>()
                .join(", ");
            Err(if available.is_empty() {
                anyhow!("this table has no saved views")
            } else {
                anyhow!("no view named {arg:?} for this table (available: {available})")
            })
        }
        _ => Err(anyhow!("multiple views named {arg:?}; pass the view id")),
    }
}

pub async fn view_list(workspace: String, table: Option<String>) -> Result<()> {
    let mut client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = resolve_workspace(&client, &workspace).await?;
    let ws = load_workspace(&mut client, &room_id).await?;

    let table_ids = match table {
        Some(t) => vec![resolve_table(&ws, &t)?],
        None => ws.list_tables(),
    };

    let mut grid = vec![vec![
        "VIEW".to_string(),
        "TABLE".to_string(),
        "TYPE".to_string(),
        "FILTERS".to_string(),
        "SORT".to_string(),
        "ID".to_string(),
    ]];
    for tid in &table_ids {
        let table_name = ws
            .get_table_schema(tid)
            .map(|s| s.name)
            .unwrap_or_else(|| tid.clone());
        for vid in ws.list_views_for_table(tid) {
            let Some(vc) = ws.get_view(&vid) else {
                continue;
            };
            grid.push(vec![
                vc.name,
                table_name.clone(),
                format!("{:?}", vc.view_type).to_lowercase(),
                vc.filters.len().to_string(),
                vc.sort.len().to_string(),
                vid,
            ]);
        }
    }
    if grid.len() == 1 {
        println!("No saved views. Views created in the app show up here.");
        return Ok(());
    }
    print_aligned(&grid);
    Ok(())
}

// ── query: --where filters and --sort keys (read-side over materialized rows) ──

type Row = indexmap::IndexMap<String, serde_json::Value>;

#[derive(Clone, Copy)]
enum Op {
    Eq,
    Ne,
    Contains,
    Gt,
    Ge,
    Lt,
    Le,
}

struct Predicate {
    col_id: String,
    op: Op,
    value: String,
}

/// Split a `--where` expression into (column, operator, value), checking the
/// two-char operators (`!=`, `>=`, `<=`) before the single-char ones.
fn split_predicate(s: &str) -> Option<(&str, Op, &str)> {
    let bytes = s.as_bytes();
    for i in 0..s.len() {
        let rest = &s[i..];
        for (tok, op) in [("!=", Op::Ne), (">=", Op::Ge), ("<=", Op::Le)] {
            if rest.starts_with(tok) {
                return Some((&s[..i], op, &s[i + 2..]));
            }
        }
        for (ch, op) in [
            ('~', Op::Contains),
            ('>', Op::Gt),
            ('<', Op::Lt),
            ('=', Op::Eq),
        ] {
            if bytes[i] == ch as u8 {
                return Some((&s[..i], op, &s[i + 1..]));
            }
        }
    }
    None
}

fn parse_predicate(schema: &TableDefinition, s: &str) -> Result<Predicate> {
    let (col, op, value) = split_predicate(s).ok_or_else(|| {
        anyhow!("invalid --where {s:?}; expected col<op>value (op: = != ~ > >= < <=)")
    })?;
    Ok(Predicate {
        col_id: resolve_column(schema, col.trim())?,
        op,
        value: value.trim().to_string(),
    })
}

impl Predicate {
    fn matches(&self, row: &Row) -> bool {
        let cell = row.get(&self.col_id);
        match self.op {
            Op::Eq => cell.is_some_and(|v| render_value(v) == self.value),
            // A missing cell is "not equal" to any value.
            Op::Ne => cell.map(|v| render_value(v) != self.value).unwrap_or(true),
            Op::Contains => cell.is_some_and(|v| {
                render_value(v)
                    .to_lowercase()
                    .contains(&self.value.to_lowercase())
            }),
            Op::Gt | Op::Ge | Op::Lt | Op::Le => {
                let (Some(a), Ok(b)) = (cell.and_then(as_number), self.value.parse::<f64>()) else {
                    return false;
                };
                match self.op {
                    Op::Gt => a > b,
                    Op::Ge => a >= b,
                    Op::Lt => a < b,
                    Op::Le => a <= b,
                    _ => unreachable!(),
                }
            }
        }
    }
}

fn as_number(v: &serde_json::Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
}

struct SortKey {
    col_id: String,
    desc: bool,
    numeric: bool,
}

fn parse_sort_key(schema: &TableDefinition, s: &str) -> Result<SortKey> {
    let (desc, name) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let col_id = resolve_column(schema, name.trim())?;
    let numeric = matches!(schema.columns[&col_id].column_type, ColumnType::Number);
    Ok(SortKey {
        col_id,
        desc,
        numeric,
    })
}

fn compare_by_keys(a: &Row, b: &Row, keys: &[SortKey]) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    for k in keys {
        // Missing values sort last (ascending), before any `desc` reversal.
        let mut ord = if k.numeric {
            cmp_option(
                a.get(&k.col_id).and_then(as_number),
                b.get(&k.col_id).and_then(as_number),
                |x, y| x.partial_cmp(y).unwrap_or(Ordering::Equal),
            )
        } else {
            cmp_option(
                a.get(&k.col_id).map(render_value),
                b.get(&k.col_id).map(render_value),
                |x, y| x.cmp(y),
            )
        };
        if k.desc {
            ord = ord.reverse();
        }
        if ord != Ordering::Equal {
            return ord;
        }
    }
    // Stable tiebreak by row id.
    let aid = a.get("_row_id").and_then(|v| v.as_str()).unwrap_or("");
    let bid = b.get("_row_id").and_then(|v| v.as_str()).unwrap_or("");
    aid.cmp(bid)
}

/// Compare two `Option`s with present-before-absent so missing values sort last.
fn cmp_option<T>(
    a: Option<T>,
    b: Option<T>,
    cmp: impl Fn(&T, &T) -> std::cmp::Ordering,
) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a, b) {
        (Some(x), Some(y)) => cmp(&x, &y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
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
    let updates = apply_cells(&mut ws, &schema, &table_id, &row_id, &cells)?;

    client
        .send_cell_batch(&updates)
        .await
        .context("sending row")?;
    println!("Added row {row_id} to \"{}\"", schema.name);
    Ok(())
}

pub async fn row_set(
    workspace: String,
    table: String,
    row_id: String,
    cells: Vec<String>,
) -> Result<()> {
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

    // Require the row to already exist so a mistyped id can't silently create a
    // phantom row.
    let exists = ws
        .get_table_rows(&table_id)
        .map_err(|e| anyhow!("reading rows: {e}"))?
        .iter()
        .any(|r| r.get("_row_id").and_then(|v| v.as_str()) == Some(row_id.as_str()));
    if !exists {
        return Err(anyhow!(
            "no row {row_id:?} in table {table_id} — check `tidework table show`"
        ));
    }

    // Only the named cells change; every other cell on the row is left as-is.
    let updates = apply_cells(&mut ws, &schema, &table_id, &row_id, &cells)?;

    client
        .send_cell_batch(&updates)
        .await
        .context("sending row update")?;
    println!("Updated row {row_id} in \"{}\"", schema.name);
    Ok(())
}

/// Write `count` single-cell edits in ONE client cycle, for benchmark seeding.
///
/// The shape it produces is the shape the walk pays for: one Matrix event per
/// edit, each carrying the user write plus its compaction bumps — the same
/// events `row set` produces. What it does NOT repeat per edit is the client
/// cycle around them: restore, sync, load the workspace, write the snapshot.
///
/// That cycle is the reason seeding through `row set` cannot reach a realistic
/// room. Each invocation rehydrates the whole snapshot (~0.14 ms per cell), so
/// a 10k-row workspace costs ~10 s per edit and the ~70k events such a
/// workspace really accumulates would take about a day to lay down. Here the
/// per-edit cost is the send alone.
///
/// It is deliberately NOT a general bulk-import path: values are throwaway and
/// every edit hits the same column. Use `import` to load data.
pub async fn seed_edits(
    workspace: String,
    table: String,
    column: String,
    count: usize,
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

    let rows: Vec<String> = ws
        .get_table_rows(&table_id)
        .map_err(|e| anyhow!("reading rows: {e}"))?
        .iter()
        .filter_map(|r| {
            r.get("_row_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .collect();
    if rows.is_empty() {
        return Err(anyhow!(
            "table {table_id} has no rows — seed data with `import` first"
        ));
    }

    let started = std::time::Instant::now();
    // Bumps actually emitted, counted rather than assumed. The nominal figure
    // is BUMP_CELLS_PER_WRITE (16), but BUMP_BYTE_BUDGET can bind first, and
    // the difference decides how many events coverage really takes — the
    // quantity every cold-start projection rests on.
    let mut total_bumps = 0usize;
    for i in 0..count {
        // Cycle the rows so edits spread across the table rather than piling
        // onto one row, which would make every bump target the same cells.
        let row_id = &rows[i % rows.len()];
        let value = serde_json::json!(format!("seeded {i}"));
        let updates = ws
            .update_cell_with_bump(&table_id, row_id, &col_id, value)
            .map_err(|e| anyhow!("writing cell: {e}"))?;
        total_bumps += updates.len().saturating_sub(1);
        // One event per edit, exactly as an interactive write produces.
        client
            .send_cell_batch(&updates)
            .await
            .context("sending seeded edit")?;
        if (i + 1) % 250 == 0 {
            eprintln!("  {}/{count} ({:?})", i + 1, started.elapsed());
        }
    }

    // No snapshot written. load_workspace already persisted one on the way in,
    // and its marker predates these writes — so the next load walks the events
    // just sent, which is correct and is also exactly what a benchmark wants to
    // measure. Writing a fresher one here would hide the history from the very
    // runs that exist to read it.
    println!(
        "Wrote {count} edits to {table_id} in {:?}",
        started.elapsed()
    );
    if count > 0 {
        println!(
            "Bumps per write: {:.2} (nominal {}); coverage of {} cells needs ~{} events",
            total_bumps as f64 / count as f64,
            16,
            ws.export_cells().len(),
            if total_bumps > 0 {
                (ws.export_cells().len() as f64 / (total_bumps as f64 / count as f64)).ceil()
                    as usize
            } else {
                0
            }
        );
    }
    Ok(())
}

/// Build the cell updates for a set of `column=value` assignments against one
/// row (shared by `row add` and `row set`). Each assignment writes exactly one
/// cell — columns not listed are untouched. Values are validated per column.
fn apply_cells(
    ws: &mut Workspace,
    schema: &TableDefinition,
    table_id: &str,
    row_id: &str,
    cells: &[String],
) -> Result<Vec<CellUpdate>> {
    let mut updates = Vec::new();
    for assignment in cells {
        let (col, raw) = assignment
            .split_once('=')
            .ok_or_else(|| anyhow!("expected column=value, got {assignment:?}"))?;
        let col_id = resolve_column(schema, col)?;
        let value = coerce_and_validate(&schema.columns[&col_id], raw)?;
        updates.extend(
            ws.update_cell_with_bump(table_id, row_id, &col_id, value)
                .map_err(|e| anyhow!("writing cell: {e}"))?,
        );
    }
    Ok(updates)
}

pub async fn row_delete(workspace: String, table: String, row_id: String) -> Result<()> {
    let mut client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = resolve_workspace(&client, &workspace).await?;
    let mut ws = load_workspace(&mut client, &room_id).await?;

    let table_id = resolve_table(&ws, &table)?;
    let updates = ws
        .delete_row(&table_id, &row_id)
        .map_err(|e| anyhow!("deleting row: {e}"))?;
    client
        .send_cell_batch(&updates)
        .await
        .context("sending row delete")?;
    println!("Deleted row {row_id} from table {table_id}");
    Ok(())
}

/// Translate the `--before/--after/--first/--last` flags (clap guarantees
/// exactly one) into a `MovePosition`, resolving a row id / column arg via `f`.
fn parse_position(
    before: Option<String>,
    after: Option<String>,
    first: bool,
    last: bool,
    f: impl Fn(&str) -> Result<String>,
) -> Result<app_core::fractional_index::MovePosition> {
    use app_core::fractional_index::MovePosition;
    Ok(match (before, after, first, last) {
        (Some(b), _, _, _) => MovePosition::Before(f(&b)?),
        (_, Some(a), _, _) => MovePosition::After(f(&a)?),
        (_, _, true, _) => MovePosition::First,
        (_, _, _, true) => MovePosition::Last,
        _ => {
            return Err(anyhow!(
                "pass one of --before <id>, --after <id>, --first, --last"
            ))
        }
    })
}

pub async fn row_move(
    workspace: String,
    table: String,
    row_id: String,
    before: Option<String>,
    after: Option<String>,
    first: bool,
    last: bool,
) -> Result<()> {
    let mut client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = resolve_workspace(&client, &workspace).await?;
    let mut ws = load_workspace(&mut client, &room_id).await?;

    let table_id = resolve_table(&ws, &table)?;
    let position = parse_position(before, after, first, last, |id| Ok(id.to_string()))?;

    // Current display order: keyed rows sort by their `_order` key (ties by row
    // id, same as the UI); never-ordered rows follow in materialized order.
    let keys: std::collections::HashMap<String, String> = ws
        .get_row_order_keys(&table_id)
        .map_err(|e| anyhow!("reading row order: {e}"))?
        .into_iter()
        .collect();
    let mut rows: Vec<(String, Option<String>)> = ws
        .get_table_rows(&table_id)
        .map_err(|e| anyhow!("reading rows: {e}"))?
        .iter()
        .filter_map(|r| r.get("_row_id").and_then(|v| v.as_str()).map(String::from))
        .map(|id| {
            let key = keys.get(&id).cloned();
            (id, key)
        })
        .collect();
    rows.sort_by(|a, b| match (&a.1, &b.1) {
        (Some(x), Some(y)) => x.cmp(y).then_with(|| a.0.cmp(&b.0)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    let writes = app_core::fractional_index::compute_move_writes(&rows, &row_id, &position)
        .map_err(|e| anyhow!(e))?;
    let mut updates = Vec::new();
    for (id, key) in &writes {
        updates.extend(
            ws.update_cell_with_bump(&table_id, id, "_order", serde_json::json!(key))
                .map_err(|e| anyhow!("writing order key: {e}"))?,
        );
    }
    client
        .send_cell_batch(&updates)
        .await
        .context("sending row move")?;
    if writes.len() == 1 {
        println!("Moved row {row_id} in table {table_id}");
    } else {
        println!(
            "Moved row {row_id} in table {table_id} (backfilled order keys for {} rows)",
            writes.len()
        );
    }
    Ok(())
}

pub async fn column_delete(workspace: String, table: String, column: String) -> Result<()> {
    let mut client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = resolve_workspace(&client, &workspace).await?;
    let mut ws = load_workspace(&mut client, &room_id).await?;

    let table_id = resolve_table(&ws, &table)?;
    let schema = ws
        .get_table_schema(&table_id)
        .ok_or_else(|| anyhow!("table {table_id} has no schema"))?;
    let col_id = resolve_column(&schema, &column)?;
    let display_name = schema.columns[&col_id].name.clone();

    let updates = ws
        .delete_column(&table_id, &col_id)
        .map_err(|e| anyhow!("deleting column: {e}"))?;
    client
        .send_cell_batch(&updates)
        .await
        .context("sending column delete")?;
    println!("Deleted column \"{display_name}\" ({col_id}) from table {table_id}");
    Ok(())
}

pub async fn column_move(
    workspace: String,
    table: String,
    column: String,
    before: Option<String>,
    after: Option<String>,
    first: bool,
    last: bool,
) -> Result<()> {
    use app_core::fractional_index::MovePosition;

    let mut client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = resolve_workspace(&client, &workspace).await?;
    let mut ws = load_workspace(&mut client, &room_id).await?;

    let table_id = resolve_table(&ws, &table)?;
    let schema = ws
        .get_table_schema(&table_id)
        .ok_or_else(|| anyhow!("table {table_id} has no schema"))?;
    let col_id = resolve_column(&schema, &column)?;
    let position = parse_position(before, after, first, last, |c| resolve_column(&schema, c))?;

    // Columns hold plain integer orders (not fractional keys): splice the moved
    // column into place and rewrite the full order via reorder_columns.
    let mut ordered: Vec<String> = {
        let mut cols: Vec<_> = schema.columns.values().collect();
        cols.sort_by_key(|c| c.order.unwrap_or(i64::MAX));
        cols.iter().map(|c| c.id.clone()).collect()
    };
    let from = ordered
        .iter()
        .position(|id| *id == col_id)
        .ok_or_else(|| anyhow!("column {col_id} not in table order"))?;
    ordered.remove(from);
    let to = match &position {
        MovePosition::First => 0,
        MovePosition::Last => ordered.len(),
        MovePosition::Before(t) | MovePosition::After(t) => {
            if *t == col_id {
                return Err(anyhow!("cannot move a column relative to itself"));
            }
            let i = ordered
                .iter()
                .position(|id| id == t)
                .ok_or_else(|| anyhow!("anchor column {t} not found"))?;
            if matches!(position, MovePosition::Before(_)) {
                i
            } else {
                i + 1
            }
        }
    };
    ordered.insert(to, col_id.clone());

    let updates = ws
        .reorder_columns(&table_id, &ordered)
        .map_err(|e| anyhow!("reordering columns: {e}"))?;
    client
        .send_cell_batch(&updates)
        .await
        .context("sending column move")?;
    println!("Moved column {col_id} in table {table_id}");
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

// ── export / import (ADR 0004) ──────────────────────────────────────────
//
// The same archive code as the web app, so the two cannot drift. Ids are not
// preserved across a round trip: this is a portability format, not a backup
// format, and `export` says so rather than letting someone discover it.

/// Write a workspace out as a directory of CSVs, a `.zip`, or one table's
/// standalone `.csv`.
pub async fn export(workspace: String, dest: String, table: Option<String>) -> Result<()> {
    let mut client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = resolve_workspace(&client, &workspace).await?;
    let ws = load_workspace(&mut client, &room_id).await?;
    let path = std::path::Path::new(&dest);
    let is_csv = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("csv"));

    if let Some(table) = table {
        if !is_csv {
            return Err(anyhow!(
                "--table exports a single table, so the destination must end in .csv"
            ));
        }
        let table_id = resolve_table(&ws, &table)?;
        let csv = app_core::archive::table_to_csv(&ws, &table_id)
            .ok_or_else(|| anyhow!("table {table:?} not found"))?;
        write_file(path, csv.as_bytes())?;
        println!("Exported table \"{table_id}\" to {dest}");
        return Ok(());
    }
    if is_csv {
        return Err(anyhow!(
            "a .csv destination exports one table — pass --table, or use a directory or .zip"
        ));
    }

    // Prefer the workspace's own display name; fall back to whatever the user
    // typed (which may already be that name, or a room id).
    let name = client
        .list_workspaces()
        .await
        .ok()
        .and_then(|list| {
            list.into_iter()
                .find(|w| w.room_id == room_id && !w.name.is_empty())
                .map(|w| w.name)
        })
        .unwrap_or_else(|| workspace.clone());
    let archive = app_core::archive::Archive::from_workspace(&ws, name);
    let tables = archive.tables.len();
    let rows: usize = archive.tables.iter().map(|t| t.rows.len()).sum();

    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
    {
        let bytes = archive.to_zip().map_err(|e| anyhow!("packing zip: {e}"))?;
        write_file(path, &bytes)?;
    } else {
        for (rel, contents) in archive.to_files() {
            write_file(&path.join(&rel), contents.as_bytes())?;
        }
    }
    println!("Exported {tables} table(s), {rows} row(s) to {dest}");
    println!("note: row and column ids are re-minted on import — this is a portability format");
    Ok(())
}

/// Read an archive (directory, `.zip`, or single `.csv`) into a workspace.
pub async fn import(
    workspace: String,
    src: String,
    table: Option<String>,
    dry_run: bool,
) -> Result<()> {
    let path = std::path::Path::new(&src);
    let archive = read_archive(path, table)?;

    let mut client = restore_client().await?;
    client.sync_once().await.context("initial sync")?;
    let room_id = resolve_workspace(&client, &workspace).await?;
    let mut ws = load_workspace(&mut client, &room_id).await?;

    if dry_run {
        for t in &archive.tables {
            let existing = ws.get_table_schema(&t.id);
            let issues = app_core::archive::validate_table(&ws, t, &t.columns);
            println!(
                "{} {}: {} row(s), {} column(s){}",
                if existing.is_some() {
                    "append to"
                } else {
                    "create"
                },
                t.id,
                t.rows.len(),
                t.columns.len(),
                if issues.is_empty() {
                    String::new()
                } else {
                    format!(" — {} value(s) would not import", issues.len())
                }
            );
        }
        println!("(dry run — nothing was written)");
        return Ok(());
    }

    let stamp = now_ms();
    let result = archive.apply_to_workspace(&mut ws, &mut |t, r| format!("row_{stamp}_{t}_{r}"));
    if !result.updates.is_empty() {
        client
            .send_cell_batch(&result.updates)
            .await
            .context("sending imported rows")?;
    }
    println!(
        "Imported {} row(s) into {} table(s)",
        result.rows_written,
        archive.tables.len()
    );
    if !result.issues.is_empty() {
        println!("{} value(s) could not be applied:", result.issues.len());
        for i in result.issues.iter().take(10) {
            println!("  {}[{}].{}: {}", i.table, i.row, i.column, i.message);
        }
        if result.issues.len() > 10 {
            println!("  … and {} more", result.issues.len() - 10);
        }
    }
    Ok(())
}

/// Read an archive from a directory, a `.zip`, or a single `.csv`.
fn read_archive(
    path: &std::path::Path,
    table: Option<String>,
) -> Result<app_core::archive::Archive> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if ext == "csv" {
        let csv =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let name = table.unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "imported".into())
        });
        let id = slug(&name);
        return Ok(app_core::archive::Archive {
            name: name.clone(),
            description: String::new(),
            tables: vec![app_core::archive::table_from_csv(&id, &name, &csv)],
            views: Vec::new(),
        });
    }
    if ext == "zip" {
        let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        return app_core::archive::Archive::from_zip(&bytes)
            .map_err(|e| anyhow!("reading archive: {e}"));
    }

    // A directory: gather every .csv under it, keyed by its relative path.
    let mut files = app_core::archive::Files::new();
    collect_csvs(path, path, &mut files)?;
    if files.is_empty() {
        return Err(anyhow!("no .csv files found under {}", path.display()));
    }
    app_core::archive::Archive::from_files(&files).map_err(|e| anyhow!("reading archive: {e}"))
}

fn collect_csvs(
    root: &std::path::Path,
    dir: &std::path::Path,
    files: &mut app_core::archive::Files,
) -> Result<()> {
    for entry in std::fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
        let path = entry?.path();
        if path.is_dir() {
            collect_csvs(root, &path, files)?;
        } else if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("csv"))
        {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            files.insert(rel, std::fs::read_to_string(&path)?);
        }
    }
    Ok(())
}

fn write_file(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    std::fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> TableDefinition {
        TableDefinition::new("t", "T")
            .with_column(
                ColumnDefinition::new("status", "Status", ColumnType::Select).with_order(0),
            )
            .with_column(
                ColumnDefinition::new("priority", "Priority", ColumnType::Number).with_order(1),
            )
            .with_column(ColumnDefinition::new("name", "Name", ColumnType::Text).with_order(2))
    }

    fn row(id: &str, status: &str, pri: i64, name: &str) -> Row {
        let mut r = Row::new();
        r.insert("_row_id".into(), json!(id));
        r.insert("status".into(), json!(status));
        r.insert("priority".into(), json!(pri));
        r.insert("name".into(), json!(name));
        r
    }

    fn pred(s: &str) -> Predicate {
        parse_predicate(&schema(), s).unwrap()
    }

    #[test]
    fn where_eq_ne_contains() {
        let r = row("1", "open", 2, "Fix login");
        assert!(pred("status=open").matches(&r));
        assert!(!pred("status=closed").matches(&r));
        assert!(pred("status!=closed").matches(&r));
        assert!(pred("name~login").matches(&r)); // case-insensitive substring
        assert!(pred("name~LOGIN").matches(&r));
        assert!(!pred("name~logout").matches(&r));
    }

    #[test]
    fn where_numeric_ops() {
        let r = row("1", "open", 2, "x");
        assert!(pred("priority<=2").matches(&r));
        assert!(pred("priority>=2").matches(&r));
        assert!(pred("priority>1").matches(&r));
        assert!(!pred("priority<2").matches(&r));
    }

    #[test]
    fn where_resolves_by_name_and_handles_missing_cell() {
        let mut r = Row::new();
        r.insert("_row_id".into(), json!("1"));
        // No status cell: `=` is false, `!=` is true.
        assert!(!pred("status=open").matches(&r));
        assert!(pred("status!=open").matches(&r));
        // Column resolved by display name.
        r.insert("priority".into(), json!(3));
        assert!(pred("Priority>=3").matches(&r));
    }

    #[test]
    fn bad_predicate_errors() {
        assert!(parse_predicate(&schema(), "statusopen").is_err()); // no operator
        assert!(parse_predicate(&schema(), "nope=x").is_err()); // unknown column
    }

    fn sorted_ids(rows: &mut [Row], key: &str) -> Vec<String> {
        let sk = vec![parse_sort_key(&schema(), key).unwrap()];
        rows.sort_by(|a, b| compare_by_keys(a, b, &sk));
        rows.iter()
            .map(|r| r.get("_row_id").unwrap().as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn sort_numeric_and_string_asc_desc() {
        // priorities 2,0,1 with ids a,b,c.
        let mut rows = vec![
            row("a", "open", 2, "banana"),
            row("b", "open", 0, "apple"),
            row("c", "open", 1, "cherry"),
        ];
        assert_eq!(sorted_ids(&mut rows, "priority"), ["b", "c", "a"]);
        assert_eq!(sorted_ids(&mut rows, "-priority"), ["a", "c", "b"]);
        assert_eq!(sorted_ids(&mut rows, "name"), ["b", "a", "c"]); // apple,banana,cherry
    }

    #[test]
    fn missing_sort_value_sorts_last() {
        let mut missing = Row::new();
        missing.insert("_row_id".into(), json!("z"));
        let mut rows = vec![row("a", "open", 1, "a"), missing];
        assert_eq!(sorted_ids(&mut rows, "priority"), ["a", "z"]);
    }
}
