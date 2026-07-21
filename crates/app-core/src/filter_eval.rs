//! Native evaluation of saved-view filters and sorts over materialized rows —
//! the Rust mirror of `ui/src/lib/filters.ts` (which documents the semantics).
//! Keep the two in sync: a view must select the same rows in the CLI as in the
//! app.
//!
//! `is_today` compares against a caller-supplied `today` (`YYYY-MM-DD`, the
//! caller's local calendar date) so this module needs no clock and stays
//! portable across native and wasm.

use serde_json::Value;

use crate::schema::{ColumnType, TableDefinition};
use crate::views::{FilterConfig, FilterOperator, SortConfig, SortDirection};

/// A materialized row, as returned by `Workspace::get_table_rows`.
pub type Row = indexmap::IndexMap<String, Value>;

/// Empty = missing cell, `null`, `""`, or an empty array (mirrors the TS
/// `isEmpty`).
fn is_empty(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        Some(Value::Array(a)) => a.is_empty(),
        _ => false,
    }
}

/// JS `String(value)` for the value shapes cells take: bare strings, JS-style
/// numbers (no trailing `.0`), `true`/`false`, arrays joined with `,`.
fn stringify(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if f.fract() == 0.0 && f.abs() < 1e15 {
                    return format!("{}", f as i64);
                }
            }
            n.to_string()
        }
        Value::Array(a) => a.iter().map(stringify).collect::<Vec<_>>().join(","),
        other => other.to_string(),
    }
}

/// JS `Number(value)`: numbers pass through, numeric strings parse, booleans
/// coerce to 1/0. Anything else is NaN (`None`).
fn as_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// The `YYYY-MM-DD` calendar-day prefix of an ISO-ish date value.
fn day_prefix(v: &Value) -> String {
    let s = stringify(v);
    s.chars().take(10).collect()
}

fn equals_match(cell: Option<&Value>, filter: Option<&Value>, ctype: &ColumnType) -> bool {
    if is_empty(cell) {
        return false;
    }
    let (Some(cell), Some(filter)) = (cell, filter) else {
        return false;
    };
    match ctype {
        ColumnType::Number => match (as_number(cell), as_number(filter)) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        },
        ColumnType::Date => day_prefix(cell) == day_prefix(filter),
        ColumnType::Boolean => cell == filter,
        _ => stringify(cell) == stringify(filter),
    }
}

fn contains_match(cell: Option<&Value>, filter: Option<&Value>) -> bool {
    if is_empty(cell) {
        return false;
    }
    let (Some(cell), Some(filter)) = (cell, filter) else {
        return false;
    };
    stringify(cell)
        .to_lowercase()
        .contains(&stringify(filter).to_lowercase())
}

/// Ordered comparison for `>` `>=` `<` `<=`. Dates compare lexicographically on
/// the ISO string (ordering-equivalent to the TS `Date.parse` for the
/// `YYYY-MM-DD` values date cells hold); numbers numerically. Empty or
/// unparseable on either side means "no ordering" (`None` → condition false).
fn compare(
    cell: Option<&Value>,
    filter: Option<&Value>,
    ctype: &ColumnType,
) -> Option<std::cmp::Ordering> {
    if is_empty(cell) || is_empty(filter) {
        return None;
    }
    let (cell, filter) = (cell?, filter?);
    if matches!(ctype, ColumnType::Date) {
        return Some(stringify(cell).cmp(&stringify(filter)));
    }
    let (a, b) = (as_number(cell)?, as_number(filter)?);
    a.partial_cmp(&b)
}

fn as_string_array(v: Option<&Value>) -> Option<Vec<String>> {
    match v {
        Some(Value::Array(a)) => Some(a.iter().map(stringify).collect()),
        _ => None,
    }
}

/// Whether one cell value satisfies one operator (the TS `matchesCondition`).
/// `today` is the caller's local date as `YYYY-MM-DD`, used only by `IsToday`.
pub fn matches_condition(
    cell: Option<&Value>,
    op: &FilterOperator,
    filter: Option<&Value>,
    ctype: &ColumnType,
    today: &str,
) -> bool {
    use FilterOperator::*;
    match op {
        IsEmpty => is_empty(cell),
        IsNotEmpty => !is_empty(cell),
        IsToday => !is_empty(cell) && cell.map(day_prefix).as_deref() == Some(today),
        Equals => equals_match(cell, filter, ctype),
        NotEquals => is_empty(cell) || !equals_match(cell, filter, ctype),
        Contains => contains_match(cell, filter),
        NotContains => !contains_match(cell, filter),
        GreaterThan => compare(cell, filter, ctype) == Some(std::cmp::Ordering::Greater),
        GreaterThanOrEqual => {
            matches!(compare(cell, filter, ctype), Some(o) if o != std::cmp::Ordering::Less)
        }
        LessThan => compare(cell, filter, ctype) == Some(std::cmp::Ordering::Less),
        LessThanOrEqual => {
            matches!(compare(cell, filter, ctype), Some(o) if o != std::cmp::Ordering::Greater)
        }
        IsAnyOf => {
            if is_empty(cell) {
                return false;
            }
            let (Some(cell), Some(Value::Array(opts))) = (cell, filter) else {
                return false;
            };
            let cell = stringify(cell);
            opts.iter().any(|v| stringify(v) == cell)
        }
        HasAnyOf => match (as_string_array(cell), as_string_array(filter)) {
            (Some(cell), Some(want)) => want.iter().any(|v| cell.contains(v)),
            _ => false,
        },
        HasAllOf => match as_string_array(filter) {
            Some(want) => {
                let cell = as_string_array(cell).unwrap_or_default();
                want.iter().all(|v| cell.contains(v))
            }
            None => false,
        },
        HasNoneOf => match as_string_array(filter) {
            Some(want) => {
                let cell = as_string_array(cell).unwrap_or_default();
                !want.iter().any(|v| cell.contains(v))
            }
            None => false,
        },
    }
}

/// Whether a row passes EVERY filter (AND — the TS `applyFilters`). A filter
/// whose column isn't in the schema is ignored (treated as pass), matching the
/// app: a stale view must not silently hide rows.
pub fn row_matches(
    row: &Row,
    filters: &[FilterConfig],
    schema: &TableDefinition,
    today: &str,
) -> bool {
    filters.iter().all(|f| {
        let Some(col) = schema.columns.get(&f.column_id) else {
            return true;
        };
        matches_condition(
            row.get(&f.column_id),
            &f.operator,
            f.value.as_ref(),
            &col.column_type,
            today,
        )
    })
}

/// Sort rows by a view's sort keys, in order: numeric for Number columns,
/// string otherwise; missing values last (before any descending reversal);
/// stable tiebreak on `_row_id`.
pub fn sort_rows(rows: &mut [Row], sort: &[SortConfig], schema: &TableDefinition) {
    use std::cmp::Ordering;
    rows.sort_by(|a, b| {
        for key in sort {
            let numeric = schema
                .columns
                .get(&key.column_id)
                .is_some_and(|c| matches!(c.column_type, ColumnType::Number));
            let (av, bv) = (a.get(&key.column_id), b.get(&key.column_id));
            // Missing values sort last regardless of direction — only the
            // present-vs-present comparison reverses for Descending.
            let ord = if numeric {
                ordered_pair(
                    av.and_then(as_number),
                    bv.and_then(as_number),
                    &key.direction,
                    |x, y| x.partial_cmp(y).unwrap_or(Ordering::Equal),
                )
            } else {
                ordered_pair(
                    (!is_empty(av)).then(|| av.map(stringify)).flatten(),
                    (!is_empty(bv)).then(|| bv.map(stringify)).flatten(),
                    &key.direction,
                    |x, y| x.cmp(y),
                )
            };
            if ord != Ordering::Equal {
                return ord;
            }
        }
        let aid = a.get("_row_id").and_then(|v| v.as_str()).unwrap_or("");
        let bid = b.get("_row_id").and_then(|v| v.as_str()).unwrap_or("");
        aid.cmp(bid)
    });
}

/// Compare two optional keys: present-vs-present per `cmp` (reversed for
/// Descending); a missing value sorts last in either direction.
fn ordered_pair<T>(
    a: Option<T>,
    b: Option<T>,
    direction: &SortDirection,
    cmp: impl Fn(&T, &T) -> std::cmp::Ordering,
) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a, b) {
        (Some(x), Some(y)) => {
            let ord = cmp(&x, &y);
            if matches!(direction, SortDirection::Descending) {
                ord.reverse()
            } else {
                ord
            }
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::ColumnDefinition;
    use serde_json::json;

    const TODAY: &str = "2026-07-21";

    fn schema() -> TableDefinition {
        TableDefinition::new("t", "T")
            .with_column(ColumnDefinition::new(
                "status",
                "Status",
                ColumnType::Select,
            ))
            .with_column(ColumnDefinition::new(
                "priority",
                "Priority",
                ColumnType::Number,
            ))
            .with_column(ColumnDefinition::new("name", "Name", ColumnType::Text))
            .with_column(ColumnDefinition::new("opened", "Opened", ColumnType::Date))
            .with_column(ColumnDefinition::new("done", "Done", ColumnType::Boolean))
            .with_column(ColumnDefinition::new(
                "tags",
                "Tags",
                ColumnType::MultiSelect,
            ))
    }

    fn cond(
        cell: Option<Value>,
        op: FilterOperator,
        filter: Option<Value>,
        ctype: ColumnType,
    ) -> bool {
        matches_condition(cell.as_ref(), &op, filter.as_ref(), &ctype, TODAY)
    }

    #[test]
    fn empty_semantics() {
        use FilterOperator::*;
        for empty in [None, Some(json!(null)), Some(json!("")), Some(json!([]))] {
            assert!(cond(empty.clone(), IsEmpty, None, ColumnType::Text));
            assert!(!cond(empty.clone(), IsNotEmpty, None, ColumnType::Text));
            // equals is false on empty; not_equals is true on empty.
            assert!(!cond(
                empty.clone(),
                Equals,
                Some(json!("x")),
                ColumnType::Text
            ));
            assert!(cond(empty, NotEquals, Some(json!("x")), ColumnType::Text));
        }
        assert!(!cond(Some(json!("x")), IsEmpty, None, ColumnType::Text));
        assert!(cond(Some(json!(0)), IsNotEmpty, None, ColumnType::Number));
    }

    #[test]
    fn equals_by_type() {
        use FilterOperator::*;
        // Number compares numerically even when one side is a string.
        assert!(cond(
            Some(json!(2)),
            Equals,
            Some(json!("2")),
            ColumnType::Number
        ));
        assert!(cond(
            Some(json!(2.0)),
            Equals,
            Some(json!(2)),
            ColumnType::Number
        ));
        // Date compares on the day prefix.
        assert!(cond(
            Some(json!("2026-07-21T10:00:00Z")),
            Equals,
            Some(json!("2026-07-21")),
            ColumnType::Date
        ));
        // Boolean is strict.
        assert!(cond(
            Some(json!(true)),
            Equals,
            Some(json!(true)),
            ColumnType::Boolean
        ));
        assert!(!cond(
            Some(json!(true)),
            Equals,
            Some(json!("true")),
            ColumnType::Boolean
        ));
        // Text stringifies both sides.
        assert!(cond(
            Some(json!("open")),
            Equals,
            Some(json!("open")),
            ColumnType::Select
        ));
        assert!(!cond(
            Some(json!("open")),
            Equals,
            Some(json!("Open")),
            ColumnType::Select
        ));
    }

    #[test]
    fn contains_is_case_insensitive() {
        use FilterOperator::*;
        assert!(cond(
            Some(json!("Fix LOGIN flow")),
            Contains,
            Some(json!("login")),
            ColumnType::Text
        ));
        assert!(!cond(
            Some(json!("abc")),
            Contains,
            Some(json!("z")),
            ColumnType::Text
        ));
        assert!(cond(
            Some(json!("abc")),
            NotContains,
            Some(json!("z")),
            ColumnType::Text
        ));
        // Empty cell: contains false, not_contains true.
        assert!(!cond(None, Contains, Some(json!("z")), ColumnType::Text));
        assert!(cond(None, NotContains, Some(json!("z")), ColumnType::Text));
    }

    #[test]
    fn ordered_comparisons() {
        use FilterOperator::*;
        assert!(cond(
            Some(json!(3)),
            GreaterThan,
            Some(json!(2)),
            ColumnType::Number
        ));
        assert!(cond(
            Some(json!(2)),
            GreaterThanOrEqual,
            Some(json!(2)),
            ColumnType::Number
        ));
        assert!(cond(
            Some(json!("1")),
            LessThan,
            Some(json!(2)),
            ColumnType::Number
        ));
        assert!(!cond(
            Some(json!("abc")),
            LessThan,
            Some(json!(2)),
            ColumnType::Number
        ));
        // Dates order lexicographically on the ISO string.
        assert!(cond(
            Some(json!("2026-07-20")),
            LessThan,
            Some(json!("2026-07-21")),
            ColumnType::Date
        ));
        // Empty on either side never matches.
        assert!(!cond(None, GreaterThan, Some(json!(1)), ColumnType::Number));
        assert!(!cond(Some(json!(1)), GreaterThan, None, ColumnType::Number));
    }

    #[test]
    fn is_today_uses_injected_date() {
        use FilterOperator::*;
        assert!(cond(
            Some(json!("2026-07-21")),
            IsToday,
            None,
            ColumnType::Date
        ));
        assert!(cond(
            Some(json!("2026-07-21T09:30:00")),
            IsToday,
            None,
            ColumnType::Date
        ));
        assert!(!cond(
            Some(json!("2026-07-20")),
            IsToday,
            None,
            ColumnType::Date
        ));
        assert!(!cond(None, IsToday, None, ColumnType::Date));
    }

    #[test]
    fn set_operators() {
        use FilterOperator::*;
        let cell = Some(json!(["a", "b"]));
        assert!(cond(
            Some(json!("open")),
            IsAnyOf,
            Some(json!(["open", "closed"])),
            ColumnType::Select
        ));
        assert!(!cond(
            Some(json!("stale")),
            IsAnyOf,
            Some(json!(["open"])),
            ColumnType::Select
        ));
        assert!(!cond(
            Some(json!("open")),
            IsAnyOf,
            Some(json!("open")),
            ColumnType::Select
        ));
        assert!(cond(
            cell.clone(),
            HasAnyOf,
            Some(json!(["b", "z"])),
            ColumnType::MultiSelect
        ));
        assert!(!cond(
            cell.clone(),
            HasAnyOf,
            Some(json!(["z"])),
            ColumnType::MultiSelect
        ));
        assert!(cond(
            cell.clone(),
            HasAllOf,
            Some(json!(["a", "b"])),
            ColumnType::MultiSelect
        ));
        assert!(!cond(
            cell.clone(),
            HasAllOf,
            Some(json!(["a", "z"])),
            ColumnType::MultiSelect
        ));
        assert!(cond(
            cell.clone(),
            HasNoneOf,
            Some(json!(["z"])),
            ColumnType::MultiSelect
        ));
        assert!(!cond(
            cell,
            HasNoneOf,
            Some(json!(["b"])),
            ColumnType::MultiSelect
        ));
        // A non-array cell has_any_of nothing.
        assert!(!cond(
            Some(json!("a")),
            HasAnyOf,
            Some(json!(["a"])),
            ColumnType::MultiSelect
        ));
    }

    fn row(id: &str, status: &str, pri: i64) -> Row {
        let mut r = Row::new();
        r.insert("_row_id".into(), json!(id));
        r.insert("status".into(), json!(status));
        r.insert("priority".into(), json!(pri));
        r
    }

    #[test]
    fn row_matches_ands_filters_and_skips_unknown_columns() {
        let filters = vec![
            FilterConfig {
                column_id: "status".into(),
                operator: FilterOperator::Equals,
                value: Some(json!("open")),
            },
            FilterConfig {
                column_id: "priority".into(),
                operator: FilterOperator::LessThanOrEqual,
                value: Some(json!(2)),
            },
            // Unknown column: ignored, must not drop the row.
            FilterConfig {
                column_id: "ghost".into(),
                operator: FilterOperator::Equals,
                value: Some(json!("x")),
            },
        ];
        let s = schema();
        assert!(row_matches(&row("1", "open", 1), &filters, &s, TODAY));
        assert!(!row_matches(&row("2", "closed", 1), &filters, &s, TODAY));
        assert!(!row_matches(&row("3", "open", 5), &filters, &s, TODAY));
    }

    #[test]
    fn sort_rows_numeric_desc_and_missing_last() {
        let s = schema();
        let mut missing = Row::new();
        missing.insert("_row_id".into(), json!("z"));
        let mut rows = vec![row("a", "open", 1), missing, row("b", "open", 3)];
        sort_rows(
            &mut rows,
            &[SortConfig {
                column_id: "priority".into(),
                direction: SortDirection::Descending,
            }],
            &s,
        );
        let ids: Vec<_> = rows
            .iter()
            .map(|r| r["_row_id"].as_str().unwrap().to_string())
            .collect();
        // 3, 1, then the row with no priority — missing stays last even descending.
        assert_eq!(ids, ["b", "a", "z"]);
    }

    #[test]
    fn sort_rows_multi_key_with_row_id_tiebreak() {
        let s = schema();
        let mut rows = vec![
            row("b", "open", 1),
            row("a", "open", 1),
            row("c", "closed", 1),
        ];
        sort_rows(
            &mut rows,
            &[
                SortConfig {
                    column_id: "status".into(),
                    direction: SortDirection::Ascending,
                },
                SortConfig {
                    column_id: "priority".into(),
                    direction: SortDirection::Ascending,
                },
            ],
            &s,
        );
        let ids: Vec<_> = rows
            .iter()
            .map(|r| r["_row_id"].as_str().unwrap().to_string())
            .collect();
        // closed before open; equal keys fall back to row id.
        assert_eq!(ids, ["c", "a", "b"]);
    }
}
