//! The CSV archive interchange format (ADR 0004).
//!
//! One format serves templates, workspace export/import, and single-table CSV
//! import. A workspace is a set of CSV files — both the data and the *metadata
//! describing* the data, because our metadata is already tabular:
//!
//! ```text
//! workspace.csv        key,value  — name, format_version
//! tables.csv           id,name,order
//! columns.csv          table,column,name,type,options,…
//! views.csv            id,name,table,type,settings
//! filters.csv          view,column,operator,value
//! sorts.csv            view,column,direction,order
//! data/<table>.csv     one per table; header row = column NAMES
//! ```
//!
//! Two properties do most of the work and are worth stating up front:
//!
//! - **Data headers are column names, not ids.** A single exported table CSV is
//!   an ordinary spreadsheet, and hand-authored files need no invented ids.
//! - **References are stored as the target row's display label, not its row
//!   id.** Nothing in an archive names a row id, so instantiating a template
//!   needs no id-remapping pass: ids are minted fresh and references resolve by
//!   label. It also means a reference column reads as text in a spreadsheet.
//!
//! This module is deliberately free of Matrix and wasm, so the format is
//! natively testable and the same code backs the web dialogue and the CLI.

use std::collections::{BTreeMap, HashMap, HashSet};

use indexmap::IndexMap;
use serde_json::Value;

use crate::schema::{ColumnDefinition, ColumnType, TableDefinition};
use crate::views::ViewConfig;
use crate::workspace::Workspace;

/// Bumped major refuses to import; bumped minor is additive and accepted.
pub const FORMAT_VERSION: &str = "1.0";

/// Separator for multi-value cells (multiselect, multireference, multimember).
/// Ambiguity with commas inside a value is resolved by matching against the
/// column's known option/label set — see [`split_multi`].
const MULTI_SEP: char = ',';

#[derive(Debug, thiserror::Error)]
pub enum ArchiveError {
    #[error("archive is missing {0}")]
    Missing(&'static str),
    #[error("unsupported archive format version {found} (this build reads {expected})")]
    UnsupportedVersion { found: String, expected: String },
    #[error("{file}: {message}")]
    Malformed { file: String, message: String },
}

type Result<T> = std::result::Result<T, ArchiveError>;

/// An archive's files, keyed by relative path (`data/tasks.csv`). Ordered, so
/// writing an archive twice produces byte-identical output — archives are
/// checked into the repo as templates and must diff cleanly.
pub type Files = BTreeMap<String, String>;

/// A workspace in transit: no ids that need to survive, no Matrix.
#[derive(Debug, Clone, Default)]
pub struct Archive {
    pub name: String,
    /// One line describing the archive, for a template gallery. Lives in
    /// `workspace.csv` as another key/value row — a template's blurb is part
    /// of the template, not something the app has to hold separately.
    pub description: String,
    pub tables: Vec<ArchiveTable>,
    pub views: Vec<ViewConfig>,
}

#[derive(Debug, Clone)]
pub struct ArchiveTable {
    pub id: String,
    pub name: String,
    pub order: Option<i64>,
    pub columns: Vec<ColumnDefinition>,
    /// Rows keyed by column **name**, values already rendered to text.
    pub rows: Vec<IndexMap<String, String>>,
}

/// A row that could not be fully applied on import. Surfaced in the preview so
/// the user sees the count before anything is committed — never silently
/// dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportIssue {
    pub table: String,
    pub row: usize,
    pub column: String,
    pub message: String,
}

// ───────────────────────────── minimal CSV codec ─────────────────────────────
//
// RFC 4180: fields quoted when they contain a delimiter, quote, or newline;
// embedded quotes doubled. Hand-rolled rather than pulled in as a dependency —
// it is the entire read path for a format we ship, so it is worth owning and
// testing directly, and it keeps `app-core` free of another wasm-bound crate.

/// Render a table of records to CSV text (CRLF-free; LF line endings).
fn write_csv(rows: &[Vec<String>]) -> String {
    let mut out = String::new();
    for row in rows {
        for (i, field) in row.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&quote_field(field));
        }
        out.push('\n');
    }
    out
}

fn quote_field(field: &str) -> String {
    let needs =
        field.contains([',', '"', '\n', '\r']) || field.starts_with(' ') || field.ends_with(' ');
    if needs {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

/// Parse CSV text into records. Tolerates CRLF, a trailing newline, and a
/// UTF-8 BOM (Excel writes one).
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    let mut any = false;

    while let Some(c) = chars.next() {
        any = true;
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => in_quotes = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    // A file that is only a trailing newline yields nothing, not one blank row.
    if !any {
        return Vec::new();
    }
    rows.retain(|r| !(r.len() == 1 && r[0].is_empty()));
    rows
}

/// Parse CSV into records keyed by the header row.
fn parse_records(text: &str) -> Vec<HashMap<String, String>> {
    let rows = parse_csv(text);
    let Some(header) = rows.first() else {
        return Vec::new();
    };
    rows[1..]
        .iter()
        .map(|r| {
            header
                .iter()
                .enumerate()
                .map(|(i, h)| (h.trim().to_string(), r.get(i).cloned().unwrap_or_default()))
                .collect()
        })
        .collect()
}

fn field<'a>(rec: &'a HashMap<String, String>, key: &str) -> &'a str {
    rec.get(key).map(|s| s.as_str()).unwrap_or("").trim()
}

// ─────────────────────────── column type <-> string ──────────────────────────

pub fn column_type_name(t: &ColumnType) -> &'static str {
    match t {
        ColumnType::Text => "text",
        ColumnType::Number => "number",
        ColumnType::Boolean => "boolean",
        ColumnType::Date => "date",
        ColumnType::Select => "select",
        ColumnType::MultiSelect => "multiselect",
        ColumnType::Reference => "reference",
        ColumnType::MultiReference => "multireference",
        ColumnType::Document => "document",
        ColumnType::Json => "json",
        ColumnType::Member => "member",
        ColumnType::MultiMember => "multimember",
    }
}

pub fn column_type_from_name(s: &str) -> ColumnType {
    match s.trim().to_ascii_lowercase().as_str() {
        "number" => ColumnType::Number,
        "boolean" | "checkbox" => ColumnType::Boolean,
        "date" => ColumnType::Date,
        "select" => ColumnType::Select,
        "multiselect" => ColumnType::MultiSelect,
        "reference" => ColumnType::Reference,
        "multireference" => ColumnType::MultiReference,
        "document" => ColumnType::Document,
        "json" => ColumnType::Json,
        "member" => ColumnType::Member,
        "multimember" => ColumnType::MultiMember,
        _ => ColumnType::Text,
    }
}

fn is_multi(t: &ColumnType) -> bool {
    matches!(
        t,
        ColumnType::MultiSelect | ColumnType::MultiReference | ColumnType::MultiMember
    )
}

/// Split a multi-value cell. When the column has a known value set (select
/// options, reference labels), values containing commas are recovered by
/// longest-match against that set; otherwise it is a plain comma split. This is
/// what makes a comma separator safe — see ADR 0004.
pub fn split_multi(cell: &str, known: &[String]) -> Vec<String> {
    let cell = cell.trim();
    if cell.is_empty() {
        return Vec::new();
    }
    let naive: Vec<String> = cell
        .split(MULTI_SEP)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if known.is_empty() || naive.iter().all(|p| known.contains(p)) {
        return naive;
    }
    // Some piece isn't a known value — a comma inside a value. Re-scan greedily,
    // preferring the longest known value that matches at the cursor.
    let mut out = Vec::new();
    let mut rest = cell;
    'scan: while !rest.is_empty() {
        let mut candidates: Vec<&String> = known.iter().filter(|k| rest.starts_with(*k)).collect();
        candidates.sort_by_key(|k| std::cmp::Reverse(k.len()));
        if let Some(hit) = candidates.first() {
            out.push((*hit).clone());
            rest = rest[hit.len()..].trim_start_matches([MULTI_SEP, ' ']);
            continue 'scan;
        }
        // Unknown value: take up to the next separator and keep going, so one
        // unrecognized entry doesn't discard the rest of the cell.
        match rest.find(MULTI_SEP) {
            Some(i) => {
                let piece = rest[..i].trim();
                if !piece.is_empty() {
                    out.push(piece.to_string());
                }
                rest = rest[i + 1..].trim_start();
            }
            None => {
                out.push(rest.trim().to_string());
                break 'scan;
            }
        }
    }
    out
}

fn join_multi(values: &[String]) -> String {
    values.join(", ")
}

// ───────────────────────────── value <-> string ──────────────────────────────

/// Render a stored cell value as archive text. `labels` resolves a referenced
/// row id to its display label.
fn value_to_text(value: &Value, col: &ColumnDefinition, labels: &LabelMap) -> String {
    match (&col.column_type, value) {
        (_, Value::Null) => String::new(),
        (ColumnType::Boolean, Value::Bool(b)) => if *b { "true" } else { "false" }.into(),
        (ColumnType::Reference, Value::String(id)) => labels.label_of(col, id),
        (ColumnType::MultiReference, Value::Array(ids)) => join_multi(
            &ids.iter()
                .filter_map(|v| v.as_str())
                .map(|id| labels.label_of(col, id))
                .collect::<Vec<_>>(),
        ),
        (t, Value::Array(items)) if is_multi(t) => join_multi(
            &items
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| v.to_string())
                })
                .collect::<Vec<_>>(),
        ),
        (ColumnType::Json, v) => v.to_string(),
        (_, Value::String(s)) => s.clone(),
        (_, v) => v.to_string(),
    }
}

/// Parse archive text into a stored cell value. Reference labels are resolved
/// through `refs`; an unresolvable label yields `Err` with a message for the
/// import preview.
fn text_to_value(
    text: &str,
    col: &ColumnDefinition,
    refs: &RefResolver,
) -> std::result::Result<Value, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(Value::Null);
    }
    match col.column_type {
        ColumnType::Number => text
            .parse::<f64>()
            .map(|n| serde_json::json!(n))
            .map_err(|_| format!("{text:?} is not a number")),
        ColumnType::Boolean => parse_bool(text)
            .map(Value::Bool)
            .ok_or_else(|| format!("{text:?} is not a yes/no value")),
        ColumnType::Json => serde_json::from_str(text).map_err(|e| format!("invalid JSON: {e}")),
        ColumnType::Reference => {
            let id = refs.resolve(col, text)?;
            Ok(Value::String(id))
        }
        ColumnType::MultiReference => {
            let known = refs.labels_for(col);
            let mut out = Vec::new();
            for label in split_multi(text, &known) {
                out.push(Value::String(refs.resolve(col, &label)?));
            }
            Ok(Value::Array(out))
        }
        ref t if is_multi(t) => {
            let known = col.options.clone().unwrap_or_default();
            Ok(Value::Array(
                split_multi(text, &known)
                    .into_iter()
                    .map(Value::String)
                    .collect(),
            ))
        }
        _ => Ok(Value::String(text.to_string())),
    }
}

fn parse_bool(s: &str) -> Option<bool> {
    match s.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "y" | "1" | "x" | "✓" | "checked" => Some(true),
        "false" | "no" | "n" | "0" | "" | "unchecked" => Some(false),
        _ => None,
    }
}

/// Row-id → label, per table, for rendering reference cells on export.
#[derive(Default)]
struct LabelMap {
    by_table: HashMap<String, HashMap<String, String>>,
}

impl LabelMap {
    fn label_of(&self, col: &ColumnDefinition, row_id: &str) -> String {
        col.reference_table
            .as_ref()
            .and_then(|t| self.by_table.get(t))
            .and_then(|m| m.get(row_id))
            .cloned()
            // A dangling reference exports as its raw id rather than as an
            // empty cell: losing the value silently would be worse than
            // exporting something the user can see is wrong.
            .unwrap_or_else(|| row_id.to_string())
    }
}

/// Label → row-id, per table, for resolving reference cells on import.
#[derive(Default)]
struct RefResolver {
    by_table: HashMap<String, HashMap<String, String>>,
}

impl RefResolver {
    fn labels_for(&self, col: &ColumnDefinition) -> Vec<String> {
        col.reference_table
            .as_ref()
            .and_then(|t| self.by_table.get(t))
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn resolve(&self, col: &ColumnDefinition, label: &str) -> std::result::Result<String, String> {
        let table = col
            .reference_table
            .as_ref()
            .ok_or_else(|| "reference column has no target table".to_string())?;
        self.by_table
            .get(table)
            .and_then(|m| m.get(label))
            .cloned()
            .ok_or_else(|| format!("no row named {label:?} in the referenced table"))
    }
}

/// Which column supplies a row's label: the explicit setting, else the first
/// text column, else the first column — matching the UI's fallback.
fn display_column(columns: &[ColumnDefinition], explicit: Option<&String>) -> Option<String> {
    if let Some(id) = explicit {
        if columns.iter().any(|c| &c.id == id) {
            return Some(id.clone());
        }
    }
    columns
        .iter()
        .find(|c| matches!(c.column_type, ColumnType::Text))
        .or_else(|| columns.first())
        .map(|c| c.id.clone())
}

// ─────────────────────────────── serialization ───────────────────────────────

impl Archive {
    /// Render to archive files. Deterministic: the same archive always produces
    /// byte-identical output, so checked-in templates diff cleanly.
    pub fn to_files(&self) -> Files {
        let mut files = Files::new();

        files.insert(
            "workspace.csv".into(),
            write_csv(&[
                vec!["key".into(), "value".into()],
                vec!["name".into(), self.name.clone()],
                vec!["description".into(), self.description.clone()],
                vec!["format_version".into(), FORMAT_VERSION.into()],
            ]),
        );

        let mut tables = vec![vec!["id".into(), "name".into(), "order".into()]];
        for t in &self.tables {
            tables.push(vec![
                t.id.clone(),
                t.name.clone(),
                t.order.map(|o| o.to_string()).unwrap_or_default(),
            ]);
        }
        files.insert("tables.csv".into(), write_csv(&tables));

        let mut columns = vec![vec![
            "table".into(),
            "column".into(),
            "name".into(),
            "type".into(),
            "options".into(),
            "reference_table".into(),
            "reference_display_column".into(),
            "width".into(),
            "required".into(),
            "default".into(),
            "order".into(),
        ]];
        for t in &self.tables {
            for c in &t.columns {
                columns.push(vec![
                    t.id.clone(),
                    c.id.clone(),
                    c.name.clone(),
                    column_type_name(&c.column_type).into(),
                    c.options
                        .as_ref()
                        .map(|o| join_multi(o))
                        .unwrap_or_default(),
                    c.reference_table.clone().unwrap_or_default(),
                    c.reference_display_column.clone().unwrap_or_default(),
                    c.width.map(|w| w.to_string()).unwrap_or_default(),
                    if c.required {
                        "true".into()
                    } else {
                        String::new()
                    },
                    c.default_value
                        .as_ref()
                        .filter(|v| !v.is_null())
                        .map(|v| match v {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .unwrap_or_default(),
                    c.order.map(|o| o.to_string()).unwrap_or_default(),
                ]);
            }
        }
        files.insert("columns.csv".into(), write_csv(&columns));

        if !self.views.is_empty() {
            let mut views = vec![vec![
                "id".into(),
                "name".into(),
                "table".into(),
                "type".into(),
                "settings".into(),
            ]];
            let mut filters = vec![vec![
                "view".into(),
                "column".into(),
                "operator".into(),
                "value".into(),
            ]];
            let mut sorts = vec![vec![
                "view".into(),
                "column".into(),
                "direction".into(),
                "order".into(),
            ]];
            for v in &self.views {
                views.push(vec![
                    v.id.clone(),
                    v.name.clone(),
                    v.table_id.clone(),
                    serde_json::to_value(&v.view_type)
                        .ok()
                        .and_then(|x| x.as_str().map(str::to_string))
                        .unwrap_or_else(|| "table".into()),
                    view_settings_json(v),
                ]);
                for f in &v.filters {
                    filters.push(vec![
                        v.id.clone(),
                        f.column_id.clone(),
                        serde_json::to_value(&f.operator)
                            .ok()
                            .and_then(|x| x.as_str().map(str::to_string))
                            .unwrap_or_default(),
                        // Scalars stay plain; arrays and spans are the only
                        // JSON in an archive besides `settings`.
                        match f.value.as_ref() {
                            None | Some(Value::Null) => String::new(),
                            Some(Value::String(s)) => s.clone(),
                            Some(other) => other.to_string(),
                        },
                    ]);
                }
                for (i, s) in v.sort.iter().enumerate() {
                    sorts.push(vec![
                        v.id.clone(),
                        s.column_id.clone(),
                        serde_json::to_value(&s.direction)
                            .ok()
                            .and_then(|x| x.as_str().map(str::to_string))
                            .unwrap_or_else(|| "asc".into()),
                        i.to_string(),
                    ]);
                }
            }
            files.insert("views.csv".into(), write_csv(&views));
            if filters.len() > 1 {
                files.insert("filters.csv".into(), write_csv(&filters));
            }
            if sorts.len() > 1 {
                files.insert("sorts.csv".into(), write_csv(&sorts));
            }
        }

        for t in &self.tables {
            let header: Vec<String> = t.columns.iter().map(|c| c.name.clone()).collect();
            let mut rows = vec![header.clone()];
            for row in &t.rows {
                rows.push(
                    header
                        .iter()
                        .map(|h| row.get(h).cloned().unwrap_or_default())
                        .collect(),
                );
            }
            files.insert(format!("data/{}.csv", t.id), write_csv(&rows));
        }

        files
    }

    /// Read archive files. Only `workspace.csv` is strictly required; an
    /// archive with no `columns.csv` imports with inferred types, and one with
    /// no `data/` is a structure-only template.
    pub fn from_files(files: &Files) -> Result<Archive> {
        let meta = files
            .get("workspace.csv")
            .ok_or(ArchiveError::Missing("workspace.csv"))?;
        let mut name = String::new();
        let mut description = String::new();
        let mut version = FORMAT_VERSION.to_string();
        for rec in parse_csv(meta).into_iter().skip(1) {
            match (rec.first().map(String::as_str), rec.get(1)) {
                (Some("name"), Some(v)) => name = v.clone(),
                (Some("description"), Some(v)) => description = v.clone(),
                (Some("format_version"), Some(v)) => version = v.trim().to_string(),
                _ => {}
            }
        }
        let major = |v: &str| v.split('.').next().unwrap_or("").to_string();
        if major(&version) != major(FORMAT_VERSION) {
            return Err(ArchiveError::UnsupportedVersion {
                found: version,
                expected: FORMAT_VERSION.into(),
            });
        }

        // columns.csv, grouped by table
        let mut cols_by_table: HashMap<String, Vec<ColumnDefinition>> = HashMap::new();
        if let Some(text) = files.get("columns.csv") {
            for rec in parse_records(text) {
                let table = field(&rec, "table").to_string();
                let ty = column_type_from_name(field(&rec, "type"));
                let mut col =
                    ColumnDefinition::new(field(&rec, "column"), field(&rec, "name"), ty.clone());
                let opts = field(&rec, "options");
                if !opts.is_empty() {
                    col.options = Some(split_multi(opts, &[]));
                }
                for (target, key) in [
                    (&mut col.reference_table, "reference_table"),
                    (
                        &mut col.reference_display_column,
                        "reference_display_column",
                    ),
                ] {
                    let v = field(&rec, key);
                    if !v.is_empty() {
                        *target = Some(v.to_string());
                    }
                }
                col.width = field(&rec, "width").parse::<f64>().ok();
                col.required = parse_bool(field(&rec, "required")).unwrap_or(false);
                col.order = field(&rec, "order").parse::<i64>().ok();
                let default = field(&rec, "default");
                if !default.is_empty() {
                    col.default_value = Some(match ty {
                        ColumnType::Number => default
                            .parse::<f64>()
                            .map(|n| serde_json::json!(n))
                            .unwrap_or(Value::String(default.into())),
                        ColumnType::Boolean => Value::Bool(parse_bool(default).unwrap_or(false)),
                        _ => Value::String(default.to_string()),
                    });
                }
                cols_by_table.entry(table).or_default().push(col);
            }
        }

        // tables.csv (+ any table that only appears under data/)
        let mut tables: Vec<ArchiveTable> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        if let Some(text) = files.get("tables.csv") {
            for rec in parse_records(text) {
                let id = field(&rec, "id").to_string();
                if id.is_empty() {
                    continue;
                }
                seen.insert(id.clone());
                let name = field(&rec, "name");
                tables.push(ArchiveTable {
                    columns: cols_by_table.remove(&id).unwrap_or_default(),
                    name: if name.is_empty() {
                        id.clone()
                    } else {
                        name.into()
                    },
                    order: field(&rec, "order").parse::<i64>().ok(),
                    id,
                    rows: Vec::new(),
                });
            }
        }
        for path in files.keys() {
            let Some(id) = path
                .strip_prefix("data/")
                .and_then(|p| p.strip_suffix(".csv"))
            else {
                continue;
            };
            if seen.insert(id.to_string()) {
                tables.push(ArchiveTable {
                    id: id.to_string(),
                    name: id.to_string(),
                    order: None,
                    columns: cols_by_table.remove(id).unwrap_or_default(),
                    rows: Vec::new(),
                });
            }
        }

        // data/<table>.csv — headers are column NAMES; any header without a
        // manifested column becomes an inferred one, so a bare CSV imports.
        for t in &mut tables {
            let Some(text) = files.get(&format!("data/{}.csv", t.id)) else {
                continue;
            };
            let rows = parse_csv(text);
            let Some(header) = rows.first().cloned() else {
                continue;
            };
            let body = &rows[1..];
            for (i, h) in header.iter().enumerate() {
                let h = h.trim();
                if h.is_empty() || t.columns.iter().any(|c| c.name == h) {
                    continue;
                }
                let sample: Vec<&str> = body
                    .iter()
                    .filter_map(|r| r.get(i))
                    .map(String::as_str)
                    .collect();
                let (ty, options) = infer_column_type(&sample);
                let mut col = ColumnDefinition::new(slugify(h), h, ty);
                col.options = options;
                col.order = Some(i as i64);
                t.columns.push(col);
            }
            for r in body {
                let mut row = IndexMap::new();
                for (i, h) in header.iter().enumerate() {
                    row.insert(h.trim().to_string(), r.get(i).cloned().unwrap_or_default());
                }
                t.rows.push(row);
            }
        }
        // Tables listed only in columns.csv still belong in the archive.
        for (id, columns) in cols_by_table {
            if seen.insert(id.clone()) {
                tables.push(ArchiveTable {
                    name: id.clone(),
                    id,
                    order: None,
                    columns,
                    rows: Vec::new(),
                });
            }
        }

        let views = read_views(files)?;
        Ok(Archive {
            name,
            description,
            tables,
            views,
        })
    }
}

fn view_settings_json(v: &ViewConfig) -> String {
    let mut settings = serde_json::Map::new();
    for (key, value) in [
        ("kanban", serde_json::to_value(&v.kanban_config).ok()),
        ("calendar", serde_json::to_value(&v.calendar_config).ok()),
        ("tasklist", serde_json::to_value(&v.tasklist_config).ok()),
        ("table", serde_json::to_value(&v.table_config).ok()),
    ] {
        if let Some(value) = value {
            if !value.is_null() {
                settings.insert(key.into(), value);
            }
        }
    }
    if settings.is_empty() {
        String::new()
    } else {
        Value::Object(settings).to_string()
    }
}

fn read_views(files: &Files) -> Result<Vec<ViewConfig>> {
    let Some(text) = files.get("views.csv") else {
        return Ok(Vec::new());
    };
    let mut views: Vec<ViewConfig> = Vec::new();
    for rec in parse_records(text) {
        let id = field(&rec, "id").to_string();
        if id.is_empty() {
            continue;
        }
        // Rebuild through serde so the view's own shape stays the single
        // definition of what a view is — this module doesn't restate it.
        let settings: serde_json::Map<String, Value> = match field(&rec, "settings") {
            "" => serde_json::Map::new(),
            s => serde_json::from_str(s).map_err(|e| ArchiveError::Malformed {
                file: "views.csv".into(),
                message: format!("view {id}: settings is not JSON: {e}"),
            })?,
        };
        let mut obj = serde_json::Map::new();
        obj.insert("id".into(), Value::String(id.clone()));
        obj.insert("name".into(), Value::String(field(&rec, "name").into()));
        obj.insert(
            "table_id".into(),
            Value::String(field(&rec, "table").into()),
        );
        obj.insert(
            "view_type".into(),
            Value::String(field(&rec, "type").to_string()),
        );
        obj.insert("filters".into(), Value::Array(Vec::new()));
        obj.insert("sort".into(), Value::Array(Vec::new()));
        for (key, target) in [
            ("kanban", "kanban_config"),
            ("calendar", "calendar_config"),
            ("tasklist", "tasklist_config"),
            ("table", "table_config"),
        ] {
            if let Some(v) = settings.get(key) {
                obj.insert(target.into(), v.clone());
            }
        }
        let view: ViewConfig =
            serde_json::from_value(Value::Object(obj)).map_err(|e| ArchiveError::Malformed {
                file: "views.csv".into(),
                message: format!("view {id}: {e}"),
            })?;
        views.push(view);
    }

    if let Some(text) = files.get("filters.csv") {
        for rec in parse_records(text) {
            let Some(view) = views.iter_mut().find(|v| v.id == field(&rec, "view")) else {
                continue;
            };
            let raw = field(&rec, "value");
            let value = if raw.is_empty() {
                None
            } else {
                // Plain when scalar, JSON when an array or a span: try JSON
                // first and fall back to the literal string.
                Some(serde_json::from_str::<Value>(raw).unwrap_or(Value::String(raw.into())))
            };
            let obj = serde_json::json!({
                "column_id": field(&rec, "column"),
                "operator": field(&rec, "operator"),
                "value": value,
            });
            if let Ok(f) = serde_json::from_value(obj) {
                view.filters.push(f);
            }
        }
    }
    if let Some(text) = files.get("sorts.csv") {
        let mut records = parse_records(text);
        records.sort_by_key(|r| field(r, "order").parse::<i64>().unwrap_or(0));
        for rec in records {
            let Some(view) = views.iter_mut().find(|v| v.id == field(&rec, "view")) else {
                continue;
            };
            let obj = serde_json::json!({
                "column_id": field(&rec, "column"),
                "direction": field(&rec, "direction"),
            });
            if let Ok(s) = serde_json::from_value(obj) {
                view.sort.push(s);
            }
        }
    }
    Ok(views)
}

fn slugify(name: &str) -> String {
    let s: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    let s = s.trim_matches('_').to_string();
    if s.is_empty() {
        "column".into()
    } else {
        s
    }
}

// ──────────────────────────── type inference ────────────────────────────────

/// Guess a column's type from its values — the *starting point* for the import
/// preview, never a silent decision (ADR 0004). First match wins.
pub fn infer_column_type(values: &[&str]) -> (ColumnType, Option<Vec<String>>) {
    let present: Vec<&str> = values
        .iter()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .collect();
    if present.is_empty() {
        return (ColumnType::Text, None);
    }
    if present.iter().all(|v| is_iso_date(v)) {
        return (ColumnType::Date, None);
    }
    if present.iter().all(|v| v.parse::<f64>().is_ok()) {
        return (ColumnType::Number, None);
    }
    if present.iter().all(|v| {
        matches!(
            v.to_ascii_lowercase().as_str(),
            "true" | "false" | "yes" | "no" | "y" | "n" | "0" | "1"
        )
    }) {
        return (ColumnType::Boolean, None);
    }
    let mut distinct: Vec<String> = Vec::new();
    for v in &present {
        if !distinct.iter().any(|d| d == v) {
            distinct.push((*v).to_string());
        }
    }
    if distinct.len() <= 20 && distinct.len() * 2 <= present.len() {
        distinct.sort();
        return (ColumnType::Select, Some(distinct));
    }
    (ColumnType::Text, None)
}

/// `YYYY-MM-DD`, optionally with a time part. Deliberately strict: a loose
/// date parser turns product codes into dates.
fn is_iso_date(s: &str) -> bool {
    let date = s.split(['T', ' ']).next().unwrap_or("");
    let parts: Vec<&str> = date.split('-').collect();
    parts.len() == 3
        && parts[0].len() == 4
        && parts[1].len() == 2
        && parts[2].len() == 2
        && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit()))
        && (1..=12).contains(&parts[1].parse::<u32>().unwrap_or(0))
        && (1..=31).contains(&parts[2].parse::<u32>().unwrap_or(0))
}

// ───────────────────────────── workspace bridge ──────────────────────────────

impl Archive {
    /// Snapshot a workspace as an archive.
    pub fn from_workspace(workspace: &Workspace, name: impl Into<String>) -> Archive {
        let mut schemas: Vec<(String, TableDefinition)> = Vec::new();
        for id in workspace.list_tables() {
            if let Some(def) = workspace.get_table_schema(&id) {
                schemas.push((id, def));
            }
        }

        // Row-id → label per table, so reference cells export as text.
        let mut labels = LabelMap::default();
        for (id, def) in &schemas {
            let columns = ordered_columns(def);
            let Some(display) = display_column(&columns, None) else {
                continue;
            };
            let Ok(rows) = workspace.get_table_rows(id) else {
                continue;
            };
            let map = rows
                .iter()
                .filter_map(|r| {
                    let rid = r.get("_row_id")?.as_str()?.to_string();
                    let label = r.get(&display).and_then(|v| v.as_str()).unwrap_or("");
                    (!label.is_empty()).then_some((rid, label.to_string()))
                })
                .collect();
            labels.by_table.insert(id.clone(), map);
        }

        let order_keys: HashMap<String, String> =
            workspace.get_table_order_keys().into_iter().collect();
        let mut tables = Vec::new();
        for (idx, (id, def)) in schemas.iter().enumerate() {
            let columns = ordered_columns(def);
            let rows = workspace
                .get_table_rows(id)
                .unwrap_or_default()
                .iter()
                .map(|r| {
                    columns
                        .iter()
                        .map(|c| {
                            let text = r
                                .get(&c.id)
                                .map(|v| value_to_text(v, c, &labels))
                                .unwrap_or_default();
                            (c.name.clone(), text)
                        })
                        .collect::<IndexMap<_, _>>()
                })
                .collect();
            tables.push(ArchiveTable {
                id: id.clone(),
                name: def.name.clone(),
                // Fractional-index order keys are internal; position is what
                // survives, and re-minting is the point (ADR 0004).
                order: Some(order_keys.get(id).map(|_| idx as i64).unwrap_or(idx as i64)),
                columns,
                rows,
            });
        }

        let views = workspace
            .list_tables()
            .iter()
            .flat_map(|t| workspace.list_views_for_table(t))
            .filter_map(|v| workspace.get_view(&v))
            .collect();

        Archive {
            name: name.into(),
            description: String::new(),
            tables,
            views,
        }
    }

    /// Materialize this archive into a workspace: reconcile the tables, then
    /// write the rows, then resolve references by label.
    ///
    /// A table that already exists is **appended to**, not recreated: its
    /// columns are matched by name, the existing definition wins on type and
    /// id, and only genuinely new headers are added as columns. That is what
    /// makes "import this CSV into my table" and "import this workspace" the
    /// same code path.
    ///
    /// Row ids are minted fresh (`mint_row_id(table_index, row_index)`), which
    /// is safe precisely because nothing in an archive names a row id.
    pub fn apply_to_workspace(
        &self,
        workspace: &mut Workspace,
        mint_row_id: &mut dyn FnMut(usize, usize) -> String,
    ) -> ImportResult {
        let mut result = ImportResult::default();

        // Reconcile schemas first, and keep the columns that actually govern
        // each table — for an existing table those are the destination's, not
        // the archive's, so a CSV can't retype a live column out from under it.
        let mut effective: Vec<Vec<ColumnDefinition>> = Vec::new();
        for t in &self.tables {
            match workspace.get_table_schema(&t.id) {
                Some(existing) => {
                    let mut columns = ordered_columns(&existing);
                    let mut next_order = columns.len() as i64;
                    for c in &t.columns {
                        if columns.iter().any(|e| e.name == c.name) {
                            continue;
                        }
                        let mut c = c.clone();
                        c.order = Some(next_order);
                        next_order += 1;
                        if let Ok(updates) = workspace.add_column(&t.id, c.clone()) {
                            result.updates.extend(updates);
                            columns.push(c);
                        }
                    }
                    effective.push(columns);
                }
                None => {
                    let mut def = TableDefinition::new(&t.id, &t.name);
                    let mut columns = Vec::new();
                    for (i, c) in t.columns.iter().enumerate() {
                        let mut c = c.clone();
                        if c.order.is_none() {
                            c.order = Some(i as i64);
                        }
                        def.columns.insert(c.id.clone(), c.clone());
                        columns.push(c);
                    }
                    match workspace.create_table(def) {
                        Ok(updates) => result.updates.extend(updates),
                        Err(e) => result.issues.push(ImportIssue {
                            table: t.id.clone(),
                            row: 0,
                            column: String::new(),
                            message: format!("table could not be created: {e}"),
                        }),
                    }
                    effective.push(columns);
                }
            }
        }

        let targets: Vec<String> = effective
            .iter()
            .flatten()
            .filter_map(|c| c.reference_table.clone())
            .chain(self.tables.iter().map(|t| t.id.clone()))
            .collect();
        let mut refs = seed_resolver(workspace, &targets);

        // Mint the row ids up front, so references can resolve against rows
        // that haven't been written yet (forward references, and cycles).
        let mut row_ids: Vec<Vec<String>> = Vec::new();
        for (ti, t) in self.tables.iter().enumerate() {
            let ids: Vec<String> = (0..t.rows.len()).map(|ri| mint_row_id(ti, ri)).collect();
            let columns = &effective[ti];
            let display = display_column(columns, None)
                .and_then(|id| columns.iter().find(|c| c.id == id).cloned());
            if let Some(display) = display {
                let map = refs.by_table.entry(t.id.clone()).or_default();
                for (row, rid) in t.rows.iter().zip(&ids) {
                    let Some(label) = row.get(&display.name).map(|s| s.trim()) else {
                        continue;
                    };
                    if !label.is_empty() {
                        map.insert(label.to_string(), rid.clone());
                    }
                }
            }
            row_ids.push(ids);
        }

        for (ti, t) in self.tables.iter().enumerate() {
            for (ri, row) in t.rows.iter().enumerate() {
                let row_id = &row_ids[ti][ri];
                for c in &effective[ti] {
                    let Some(text) = row.get(&c.name) else {
                        continue;
                    };
                    match text_to_value(text, c, &refs) {
                        Ok(Value::Null) => {}
                        Ok(value) => {
                            if let Ok(update) =
                                workspace.update_cell_returning(&t.id, row_id, &c.id, value)
                            {
                                result.updates.push(update);
                            }
                        }
                        Err(message) => result.issues.push(ImportIssue {
                            table: t.id.clone(),
                            row: ri,
                            column: c.name.clone(),
                            message,
                        }),
                    }
                }
                result.rows_written += 1;
            }
        }

        for v in &self.views {
            if let Ok(updates) = workspace.create_view(v.clone()) {
                result.updates.extend(updates);
            }
        }

        result
    }
}

/// What an import did: the updates a Matrix-connected caller must send, the
/// rows written, and anything that could not be applied.
#[derive(Debug, Default)]
pub struct ImportResult {
    pub updates: Vec<tables_over_matrix::CellUpdate>,
    pub issues: Vec<ImportIssue>,
    pub rows_written: usize,
}

/// Build the label → row-id map for every table named in `targets`, from rows
/// already in the workspace. Rows that are already there are valid reference
/// targets, so an appended CSV can point at a table it doesn't itself carry.
fn seed_resolver(workspace: &Workspace, targets: &[String]) -> RefResolver {
    let mut refs = RefResolver::default();
    let mut targets = targets.to_vec();
    targets.sort();
    targets.dedup();
    for target in targets {
        let Some(schema) = workspace.get_table_schema(&target) else {
            continue;
        };
        let Some(display) = display_column(&ordered_columns(&schema), None) else {
            continue;
        };
        let map: HashMap<String, String> = workspace
            .get_table_rows(&target)
            .unwrap_or_default()
            .iter()
            .filter_map(|r| {
                let rid = r.get("_row_id")?.as_str()?.to_string();
                let label = r.get(&display)?.as_str()?.trim().to_string();
                (!label.is_empty()).then_some((label, rid))
            })
            .collect();
        refs.by_table.insert(target, map);
    }
    refs
}

/// Dry-run a table's cells against `columns` and report what wouldn't apply,
/// writing nothing. This is what lets the import preview show the failure count
/// **before** anything is committed (ADR 0004) rather than after.
///
/// Reference labels resolve against rows already in the workspace *and* rows
/// carried by this table, matching what the real import will do.
pub fn validate_table(
    workspace: &Workspace,
    table: &ArchiveTable,
    columns: &[ColumnDefinition],
) -> Vec<ImportIssue> {
    let targets: Vec<String> = columns
        .iter()
        .filter_map(|c| c.reference_table.clone())
        .chain(std::iter::once(table.id.clone()))
        .collect();
    let mut refs = seed_resolver(workspace, &targets);
    if let Some(display) = display_column(columns, None)
        .and_then(|id| columns.iter().find(|c| c.id == id).map(|c| c.name.clone()))
    {
        let map = refs.by_table.entry(table.id.clone()).or_default();
        for row in &table.rows {
            if let Some(label) = row.get(&display).map(|s| s.trim()) {
                if !label.is_empty() {
                    // The id is a placeholder: validation only asks whether the
                    // label RESOLVES, never what it resolves to.
                    map.entry(label.to_string()).or_default();
                }
            }
        }
    }

    let mut issues = Vec::new();
    for (ri, row) in table.rows.iter().enumerate() {
        for c in columns {
            let Some(text) = row.get(&c.name) else {
                continue;
            };
            if let Err(message) = text_to_value(text, c, &refs) {
                issues.push(ImportIssue {
                    table: table.id.clone(),
                    row: ri,
                    column: c.name.clone(),
                    message,
                });
            }
        }
    }
    issues
}

/// Read a standalone CSV as one table, inferring column types from the data —
/// the single-table import path. `id`/`name` name the destination; when it
/// already exists, [`Archive::apply_to_workspace`] matches these columns to it
/// by name and the destination's types win.
pub fn table_from_csv(id: &str, name: &str, csv: &str) -> ArchiveTable {
    let mut files = Files::new();
    files.insert(
        "workspace.csv".into(),
        write_csv(&[
            vec!["key".into(), "value".into()],
            vec!["name".into(), name.to_string()],
        ]),
    );
    files.insert(format!("data/{id}.csv"), csv.to_string());
    let mut archive = Archive::from_files(&files).unwrap_or_default();
    let mut table = archive.tables.pop().unwrap_or(ArchiveTable {
        id: id.to_string(),
        name: name.to_string(),
        order: None,
        columns: Vec::new(),
        rows: Vec::new(),
    });
    table.name = name.to_string();
    table
}

// ───────────────────────────── zip container ────────────────────────────────
//
// The format is a set of files; a zip is just the one-file way to hand that
// set to somebody. In-tree templates stay plain directories (diffable, and
// reviewable in a PR) — this is for export and for import of what someone
// else exported.
//
// One implementation, in Rust, rather than a Rust one for the CLI and a
// JavaScript one for the browser. Measured cost: +213 KB on an 11 MB wasm
// bundle already dominated by matrix-sdk (~2%). A container implemented twice
// is a container that eventually disagrees with itself.

impl Archive {
    /// Pack this archive into a zip.
    pub fn to_zip(&self) -> Result<Vec<u8>> {
        use zip::write::SimpleFileOptions;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            // Fixed timestamp: the archive's bytes should depend on its
            // contents alone, so re-exporting unchanged data doesn't produce a
            // different file (and templates diff cleanly).
            let options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .last_modified_time(
                    zip::DateTime::from_date_and_time(1980, 1, 1, 0, 0, 0).unwrap_or_default(),
                );
            for (path, contents) in self.to_files() {
                zip.start_file(&path, options)
                    .map_err(|e| zip_err(&path, e))?;
                std::io::Write::write_all(&mut zip, contents.as_bytes()).map_err(|e| {
                    ArchiveError::Malformed {
                        file: path.clone(),
                        message: e.to_string(),
                    }
                })?;
            }
            zip.finish().map_err(|e| zip_err("archive", e))?;
        }
        Ok(buf.into_inner())
    }

    /// Read an archive out of a zip. Directory entries and anything that isn't
    /// valid UTF-8 text are skipped rather than failing the whole import — a
    /// zip made by a file manager routinely carries `__MACOSX` noise.
    pub fn from_zip(bytes: &[u8]) -> Result<Archive> {
        let mut zip =
            zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| zip_err("archive", e))?;
        let mut files = Files::new();
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| zip_err("archive", e))?;
            if entry.is_dir() {
                continue;
            }
            let Some(path) = entry.enclosed_name() else {
                continue; // path traversal attempt, or an unrepresentable name
            };
            let path = normalize_entry_path(&path.to_string_lossy());
            if path.is_empty() {
                continue;
            }
            let mut text = String::new();
            if std::io::Read::read_to_string(&mut entry, &mut text).is_ok() {
                files.insert(path, text);
            }
        }
        Archive::from_files(&files)
    }
}

fn zip_err(file: &str, e: zip::result::ZipError) -> ArchiveError {
    ArchiveError::Malformed {
        file: file.to_string(),
        message: e.to_string(),
    }
}

/// Strip a wrapping directory and platform noise, so an archive still reads
/// when someone zipped the *folder* rather than its contents — which is what
/// most people do.
fn normalize_entry_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    if path.starts_with("__MACOSX/") || path.rsplit('/').next().is_some_and(|f| f == ".DS_Store") {
        return String::new();
    }
    // Keep `data/<table>.csv` intact but drop any prefix above it.
    for marker in [
        "workspace.csv",
        "tables.csv",
        "columns.csv",
        "views.csv",
        "filters.csv",
        "sorts.csv",
    ] {
        if let Some(idx) = path.rfind(marker) {
            if path[idx..].len() == marker.len() {
                return marker.to_string();
            }
        }
    }
    match path.rfind("data/") {
        Some(idx) => path[idx..].to_string(),
        None => path,
    }
}

/// Render one table as a standalone CSV — headers are column names, references
/// are labels, so the file opens as an ordinary spreadsheet.
pub fn table_to_csv(workspace: &Workspace, table_id: &str) -> Option<String> {
    let archive = Archive::from_workspace(workspace, "");
    let table = archive.tables.iter().find(|t| t.id == table_id)?;
    let header: Vec<String> = table.columns.iter().map(|c| c.name.clone()).collect();
    let mut rows = vec![header.clone()];
    for row in &table.rows {
        rows.push(
            header
                .iter()
                .map(|h| row.get(h).cloned().unwrap_or_default())
                .collect(),
        );
    }
    Some(write_csv(&rows))
}

fn ordered_columns(def: &TableDefinition) -> Vec<ColumnDefinition> {
    let mut columns: Vec<ColumnDefinition> = def.columns.values().cloned().collect();
    // `None` sorts last (legacy columns predate ordering), then by id so the
    // output is stable rather than HashMap-ordered.
    columns.sort_by(|a, b| {
        a.order
            .unwrap_or(i64::MAX)
            .cmp(&b.order.unwrap_or(i64::MAX))
            .then_with(|| a.id.cmp(&b.id))
    });
    columns
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(id: &str, name: &str, t: ColumnType) -> ColumnDefinition {
        ColumnDefinition::new(id, name, t)
    }

    #[test]
    fn csv_round_trips_quoting() {
        let rows = vec![
            vec!["a".to_string(), "b,c".to_string()],
            vec!["say \"hi\"".to_string(), "line\nbreak".to_string()],
            vec![" padded ".to_string(), String::new()],
        ];
        assert_eq!(parse_csv(&write_csv(&rows)), rows);
    }

    #[test]
    fn parses_crlf_and_bom() {
        let text = "\u{feff}a,b\r\n1,2\r\n";
        assert_eq!(
            parse_csv(text),
            vec![vec!["a", "b"], vec!["1", "2"]]
                .into_iter()
                .map(|r| r.into_iter().map(String::from).collect::<Vec<_>>())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn empty_input_is_no_rows() {
        assert!(parse_csv("").is_empty());
        assert!(parse_csv("\n").is_empty());
    }

    #[test]
    fn multi_split_recovers_values_containing_commas() {
        let known = vec!["Hello, world".to_string(), "Plain".to_string()];
        assert_eq!(
            split_multi("Hello, world, Plain", &known),
            vec!["Hello, world", "Plain"]
        );
        // No known set → a plain split, which is right for free text.
        assert_eq!(split_multi("a, b", &[]), vec!["a", "b"]);
    }

    #[test]
    fn multi_split_keeps_going_past_an_unknown_value() {
        let known = vec!["Known, with comma".to_string()];
        assert_eq!(
            split_multi("Mystery, Known, with comma", &known),
            vec!["Mystery", "Known, with comma"]
        );
    }

    #[test]
    fn infers_types() {
        assert_eq!(
            infer_column_type(&["2026-01-02", "2026-03-04"]).0,
            ColumnType::Date
        );
        assert_eq!(infer_column_type(&["1", "2.5", "-3"]).0, ColumnType::Number);
        assert_eq!(infer_column_type(&["yes", "no"]).0, ColumnType::Boolean);
        let (t, options) = infer_column_type(&["Todo", "Done", "Todo", "Done"]);
        assert_eq!(t, ColumnType::Select);
        assert_eq!(options.unwrap(), vec!["Done", "Todo"]);
        // High cardinality is text, not a 4-option select.
        assert_eq!(infer_column_type(&["a", "b", "c", "d"]).0, ColumnType::Text);
        // A product code is not a date.
        assert_eq!(infer_column_type(&["2026-1-2"]).0, ColumnType::Text);
    }

    fn sample_archive() -> Archive {
        let people = ArchiveTable {
            id: "people".into(),
            name: "People".into(),
            order: Some(0),
            columns: vec![col("name", "Name", ColumnType::Text)],
            rows: vec![
                IndexMap::from([("Name".to_string(), "Ada".to_string())]),
                IndexMap::from([("Name".to_string(), "Grace".to_string())]),
            ],
        };
        let mut owner = col("owner", "Owner", ColumnType::Reference);
        owner.reference_table = Some("people".into());
        owner.reference_display_column = Some("name".into());
        let mut status = col("status", "Status", ColumnType::Select);
        status.options = Some(vec!["Todo".into(), "Done".into()]);
        let tasks = ArchiveTable {
            id: "tasks".into(),
            name: "Tasks".into(),
            order: Some(1),
            columns: vec![col("title", "Title", ColumnType::Text), status, owner],
            rows: vec![IndexMap::from([
                ("Title".to_string(), "Ship it".to_string()),
                ("Status".to_string(), "Todo".to_string()),
                ("Owner".to_string(), "Ada".to_string()),
            ])],
        };
        Archive {
            name: "Demo".into(),
            description: "A sample".into(),
            tables: vec![people, tasks],
            views: Vec::new(),
        }
    }

    #[test]
    fn archive_round_trips_through_files() {
        let archive = sample_archive();
        let files = archive.to_files();
        assert!(files.contains_key("data/tasks.csv"));
        let back = Archive::from_files(&files).unwrap();
        assert_eq!(back.name, "Demo");
        assert_eq!(back.tables.len(), 2);
        let tasks = back.tables.iter().find(|t| t.id == "tasks").unwrap();
        assert_eq!(tasks.name, "Tasks");
        assert_eq!(tasks.rows.len(), 1);
        assert_eq!(tasks.rows[0]["Owner"], "Ada");
        let owner = tasks.columns.iter().find(|c| c.id == "owner").unwrap();
        assert_eq!(owner.column_type, ColumnType::Reference);
        assert_eq!(owner.reference_table.as_deref(), Some("people"));
        let status = tasks.columns.iter().find(|c| c.id == "status").unwrap();
        assert_eq!(status.options.clone().unwrap(), vec!["Todo", "Done"]);
    }

    #[test]
    fn writing_is_deterministic() {
        assert_eq!(sample_archive().to_files(), sample_archive().to_files());
    }

    #[test]
    fn refuses_a_future_major_version() {
        let mut files = sample_archive().to_files();
        files.insert(
            "workspace.csv".into(),
            "key,value\nname,X\nformat_version,2.0\n".into(),
        );
        assert!(matches!(
            Archive::from_files(&files),
            Err(ArchiveError::UnsupportedVersion { .. })
        ));
    }

    #[test]
    fn a_bare_data_csv_imports_with_inferred_types() {
        let mut files = Files::new();
        files.insert("workspace.csv".into(), "key,value\nname,Bare\n".into());
        files.insert(
            "data/notes.csv".into(),
            "Title,Count,When\nAlpha,3,2026-01-02\nBeta,4,2026-02-03\n".into(),
        );
        let archive = Archive::from_files(&files).unwrap();
        let t = &archive.tables[0];
        assert_eq!(t.id, "notes");
        assert_eq!(t.rows.len(), 2);
        let by_name = |n: &str| t.columns.iter().find(|c| c.name == n).unwrap().clone();
        assert_eq!(by_name("Count").column_type, ColumnType::Number);
        assert_eq!(by_name("When").column_type, ColumnType::Date);
        assert_eq!(by_name("Title").column_type, ColumnType::Text);
    }

    #[test]
    fn applies_to_a_workspace_resolving_references_by_label() {
        let mut ws = Workspace::new("ws");
        let result =
            sample_archive().apply_to_workspace(&mut ws, &mut |t, r| format!("row_{t}_{r}"));
        assert_eq!(result.issues, Vec::new());
        assert_eq!(result.rows_written, 3);
        // Every write is handed back for the caller to send — an import that
        // only applied locally would vanish on reload (cf. issue 980ac596).
        assert!(!result.updates.is_empty());

        let tasks = ws.get_table_rows("tasks").unwrap();
        assert_eq!(tasks.len(), 1);
        // "Ada" resolved to the minted id of People row 0 — not stored as text.
        assert_eq!(tasks[0]["owner"], Value::String("row_0_0".into()));
        assert_eq!(tasks[0]["status"], Value::String("Todo".into()));
    }

    #[test]
    fn an_unresolvable_reference_is_reported_not_dropped() {
        let mut archive = sample_archive();
        archive.tables[1].rows[0].insert("Owner".into(), "Nobody".into());
        let mut ws = Workspace::new("ws");
        let result = archive.apply_to_workspace(&mut ws, &mut |t, r| format!("row_{t}_{r}"));
        assert_eq!(result.issues.len(), 1);
        assert_eq!(result.issues[0].column, "Owner");
        assert!(result.issues[0].message.contains("Nobody"));
        // The rest of the row still landed.
        assert_eq!(ws.get_table_rows("tasks").unwrap()[0]["title"], "Ship it");
    }

    #[test]
    fn workspace_round_trip_preserves_values_through_labels() {
        let mut ws = Workspace::new("ws");
        sample_archive().apply_to_workspace(&mut ws, &mut |t, r| format!("row_{t}_{r}"));

        let exported = Archive::from_workspace(&ws, "Demo");
        let tasks = exported.tables.iter().find(|t| t.id == "tasks").unwrap();
        // The reference came back out as the label, not the minted row id.
        assert_eq!(tasks.rows[0]["Owner"], "Ada");

        // And it survives a second lap through a fresh workspace.
        let mut ws2 = Workspace::new("ws2");
        let result = Archive::from_files(&exported.to_files())
            .unwrap()
            .apply_to_workspace(&mut ws2, &mut |t, r| format!("r{t}_{r}"));
        assert_eq!(result.issues, Vec::new());
        assert_eq!(
            ws2.get_table_rows("tasks").unwrap()[0]["owner"],
            Value::String("r0_0".into())
        );
    }

    #[test]
    fn importing_into_an_existing_table_appends_and_keeps_its_types() {
        let mut ws = Workspace::new("ws");
        sample_archive().apply_to_workspace(&mut ws, &mut |t, r| format!("row_{t}_{r}"));

        // The CSV's Status column looks like free text on its own, but the
        // destination already types it as a select — the live column wins.
        let csv = "Title,Status,Notes\nSecond,Done,hello\n";
        let archive = Archive {
            name: String::new(),
            description: String::new(),
            tables: vec![table_from_csv("tasks", "Tasks", csv)],
            views: Vec::new(),
        };
        let result = archive.apply_to_workspace(&mut ws, &mut |_, r| format!("new_{r}"));
        assert_eq!(result.issues, Vec::new());

        let rows = ws.get_table_rows("tasks").unwrap();
        assert_eq!(rows.len(), 2, "appended rather than replaced");
        let added = rows.iter().find(|r| r["title"] == "Second").unwrap();
        assert_eq!(added["status"], Value::String("Done".into()));
        // The genuinely new header became a column; the matched ones did not
        // duplicate.
        let schema = ws.get_table_schema("tasks").unwrap();
        assert_eq!(schema.columns.len(), 4);
        assert!(schema.columns.values().any(|c| c.name == "Notes"));
        assert_eq!(
            schema.columns.get("status").unwrap().column_type,
            ColumnType::Select
        );
    }

    #[test]
    fn an_appended_csv_can_reference_rows_already_in_the_workspace() {
        let mut ws = Workspace::new("ws");
        sample_archive().apply_to_workspace(&mut ws, &mut |t, r| format!("row_{t}_{r}"));

        // "Grace" exists only in the workspace, not in this CSV.
        let csv = "Title,Owner\nSecond,Grace\n";
        let mut table = table_from_csv("tasks", "Tasks", csv);
        // Header→column matching by name gives it the live reference column.
        table.columns.clear();
        let result = Archive {
            name: String::new(),
            description: String::new(),
            tables: vec![table],
            views: Vec::new(),
        }
        .apply_to_workspace(&mut ws, &mut |_, r| format!("new_{r}"));

        assert_eq!(result.issues, Vec::new());
        let rows = ws.get_table_rows("tasks").unwrap();
        let added = rows.iter().find(|r| r["title"] == "Second").unwrap();
        assert_eq!(added["owner"], Value::String("row_0_1".into()));
    }

    #[test]
    fn validation_is_a_dry_run_that_writes_nothing() {
        let mut ws = Workspace::new("ws");
        sample_archive().apply_to_workspace(&mut ws, &mut |t, r| format!("row_{t}_{r}"));
        let before = ws.get_table_rows("tasks").unwrap().len();

        let table = table_from_csv("tasks", "Tasks", "Title,Owner\nA,Ada\nB,Nobody\n");
        let schema = ws.get_table_schema("tasks").unwrap();
        let columns = ordered_columns(&schema);
        let issues = validate_table(&ws, &table, &columns);

        // "Ada" is already in the workspace and resolves; "Nobody" doesn't.
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].row, 1);
        assert_eq!(issues[0].column, "Owner");
        assert_eq!(
            ws.get_table_rows("tasks").unwrap().len(),
            before,
            "validation must not write"
        );
    }

    #[test]
    fn validation_resolves_labels_carried_by_the_csv_itself() {
        let mut ws = Workspace::new("ws");
        sample_archive().apply_to_workspace(&mut ws, &mut |t, r| format!("row_{t}_{r}"));

        // A self-reference to a row this same CSV introduces must validate —
        // the real import mints its id up front, so the dry run has to agree.
        let mut owner = col("owner", "Owner", ColumnType::Reference);
        owner.reference_table = Some("tasks".into());
        let table = table_from_csv("tasks", "Tasks", "Title,Owner\nFirst,Second\nSecond,\n");
        let columns = vec![col("title", "Title", ColumnType::Text), owner];
        assert_eq!(validate_table(&ws, &table, &columns), Vec::new());
    }

    #[test]
    fn zip_round_trips_and_is_reproducible() {
        let archive = sample_archive();
        let bytes = archive.to_zip().unwrap();
        // Same contents → same bytes, so re-exporting unchanged data doesn't
        // produce a different file.
        assert_eq!(bytes, archive.to_zip().unwrap());

        let back = Archive::from_zip(&bytes).unwrap();
        assert_eq!(back.name, "Demo");
        assert_eq!(back.tables.len(), 2);
        let tasks = back.tables.iter().find(|t| t.id == "tasks").unwrap();
        assert_eq!(tasks.rows[0]["Owner"], "Ada");
    }

    #[test]
    fn a_zip_of_the_folder_still_reads() {
        // Most people zip the directory, not its contents. Both must work.
        let mut zipped = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut zipped);
            let opts = zip::write::SimpleFileOptions::default();
            for (path, contents) in sample_archive().to_files() {
                w.start_file(format!("My Workspace/{path}"), opts).unwrap();
                std::io::Write::write_all(&mut w, contents.as_bytes()).unwrap();
            }
            // Noise a Mac would add.
            w.start_file("__MACOSX/._workspace.csv", opts).unwrap();
            std::io::Write::write_all(&mut w, b"junk").unwrap();
            w.finish().unwrap();
        }
        let back = Archive::from_zip(&zipped.into_inner()).unwrap();
        assert_eq!(back.name, "Demo");
        assert_eq!(back.tables.len(), 2);
    }

    #[test]
    fn single_table_csv_export_uses_names_and_labels() {
        let mut ws = Workspace::new("ws");
        sample_archive().apply_to_workspace(&mut ws, &mut |t, r| format!("row_{t}_{r}"));

        let csv = table_to_csv(&ws, "tasks").unwrap();
        let rows = parse_csv(&csv);
        assert_eq!(rows[0], vec!["Title", "Status", "Owner"]);
        assert_eq!(rows[1], vec!["Ship it", "Todo", "Ada"]);
        assert!(table_to_csv(&ws, "nope").is_none());
    }
}
