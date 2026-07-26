//! Native evaluation of saved-view filters and sorts over materialized rows —
//! the Rust mirror of `ui/src/lib/filters.ts` (which documents the semantics).
//! Keep the two in sync: a view must select the same rows in the CLI as in the
//! app.
//!
//! Dynamic values live in a caller-supplied [`FilterContext`] rather than being
//! read from the environment: `is_today` compares against `today`
//! (`YYYY-MM-DD`, the caller's local calendar date) and the `@me` sentinel on
//! Member columns resolves to `me` (the viewer's MXID). That keeps this module
//! clock- and identity-free, so it stays portable across native and wasm — and
//! makes "assigned to me" a property of who is looking, not of the saved view.

use serde_json::Value;

use crate::schema::{ColumnType, TableDefinition};
use crate::views::{FilterConfig, FilterOperator, SortConfig, SortDirection};

/// A materialized row, as returned by `Workspace::get_table_rows`.
pub type Row = indexmap::IndexMap<String, Value>;

/// The filter value that stands for "whoever is looking" on Member columns.
/// Stored verbatim in the saved view; resolved per-viewer at evaluation time
/// (mirrors `ME` in `ui/src/lib/filters.ts`).
pub const ME: &str = "@me";

/// Everything a filter needs from the caller's environment. Both fields are
/// resolved at evaluation time, never baked into the saved view.
#[derive(Debug, Clone, Default)]
pub struct FilterContext {
    /// The caller's local calendar date as `YYYY-MM-DD` (used by `is_today`).
    pub today: String,
    /// The viewer's MXID, substituted for the [`ME`] sentinel. `None` (signed
    /// out / unknown) makes `@me` match nothing rather than match everything.
    pub me: Option<String>,
}

impl FilterContext {
    /// A context with only a date — for callers with no notion of a viewer.
    pub fn new(today: impl Into<String>) -> Self {
        Self {
            today: today.into(),
            me: None,
        }
    }

    /// Builder: set the viewer whose MXID `@me` resolves to.
    pub fn with_me(mut self, me: Option<String>) -> Self {
        self.me = me;
        self
    }
}

/// Substitute [`ME`] for the viewer's MXID in a filter value, for Member
/// columns only. Returns `None` when nothing needed substituting (the caller
/// keeps the original value). An unresolvable `@me` (no viewer) becomes `null`,
/// which the positive operators treat as "no match" — the safe direction: a
/// signed-out viewer sees nothing rather than everything.
fn resolve_me(filter: Option<&Value>, ctype: &ColumnType, ctx: &FilterContext) -> Option<Value> {
    if !matches!(ctype, ColumnType::Member | ColumnType::MultiMember) {
        return None;
    }
    let me = || ctx.me.clone().map(Value::String).unwrap_or(Value::Null);
    match filter {
        Some(Value::String(s)) if s == ME => Some(me()),
        Some(Value::Array(a)) if a.iter().any(|v| v.as_str() == Some(ME)) => Some(Value::Array(
            a.iter()
                .map(|v| {
                    if v.as_str() == Some(ME) {
                        me()
                    } else {
                        v.clone()
                    }
                })
                .collect(),
        )),
        _ => None,
    }
}

// ── Calendar arithmetic ─────────────────────────────────────────────────────
//
// Done by hand rather than with chrono so this module stays dependency-light
// and, more importantly, clock-free: every date it works with arrives from the
// caller's `FilterContext`. Howard Hinnant's civil-date algorithms, which are
// exact for the proleptic Gregorian calendar.

/// Days since 1970-01-01 for a civil date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The civil date `z` days after 1970-01-01.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Parse the `YYYY-MM-DD` prefix of a date string into days since epoch.
fn date_to_days(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = s.get(0..4)?.parse().ok()?;
    let m: i64 = s.get(5..7)?.parse().ok()?;
    let d: i64 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

/// Render days-since-epoch back as `YYYY-MM-DD`.
fn days_to_date(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// The Monday..Sunday span containing `today` (ISO 8601 weeks). 1970-01-01 was
/// a Thursday, which anchors the weekday arithmetic.
fn week_bounds(today: &str) -> Option<(String, String)> {
    let days = date_to_days(today)?;
    let weekday_from_monday = (days + 3).rem_euclid(7);
    let monday = days - weekday_from_monday;
    Some((days_to_date(monday), days_to_date(monday + 6)))
}

/// The span an `InSpan` filter selects, resolved against today.
///
/// Fixed spans carry two calendar dates. MOVING spans carry day offsets either
/// side of today, so "the last week" keeps meaning the last week tomorrow —
/// the distinction the `moving` toggle expresses.
fn resolve_span(filter: Option<&Value>, today: &str) -> Option<(String, String)> {
    let v = filter?;
    let moving = v.get("moving").and_then(|m| m.as_bool()).unwrap_or(false);
    if moving {
        let base = date_to_days(today)?;
        let from = v.get("fromDays").and_then(|d| d.as_i64()).unwrap_or(0);
        let to = v.get("toDays").and_then(|d| d.as_i64()).unwrap_or(0);
        let (lo, hi) = if from <= to { (from, to) } else { (to, from) };
        Some((days_to_date(base + lo), days_to_date(base + hi)))
    } else {
        let from = v.get("from").and_then(|d| d.as_str())?;
        let to = v.get("to").and_then(|d| d.as_str())?;
        let (from, to) = (from.get(0..10)?.to_string(), to.get(0..10)?.to_string());
        if from <= to {
            Some((from, to))
        } else {
            Some((to, from))
        }
    }
}

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
/// Dynamic filter values (`is_today`, the `@me` sentinel) resolve against
/// `ctx`.
pub fn matches_condition(
    cell: Option<&Value>,
    op: &FilterOperator,
    filter: Option<&Value>,
    ctype: &ColumnType,
    ctx: &FilterContext,
) -> bool {
    use FilterOperator::*;
    let resolved = resolve_me(filter, ctype, ctx);
    let filter = resolved.as_ref().or(filter);
    match op {
        IsEmpty => is_empty(cell),
        IsNotEmpty => !is_empty(cell),
        IsToday => !is_empty(cell) && cell.map(day_prefix).as_deref() == Some(ctx.today.as_str()),
        IsThisWeek => match (is_empty(cell), week_bounds(&ctx.today)) {
            (false, Some((start, end))) => {
                let day = cell.map(day_prefix).unwrap_or_default();
                day >= start && day <= end
            }
            _ => false,
        },
        InSpan => match (is_empty(cell), resolve_span(filter, &ctx.today)) {
            // Inclusive at both ends: a span the user typed as 1st–7th should
            // contain the 7th.
            (false, Some((start, end))) => {
                let day = cell.map(day_prefix).unwrap_or_default();
                day >= start && day <= end
            }
            _ => false,
        },
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
    ctx: &FilterContext,
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
            ctx,
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
    const ALICE: &str = "@alice:example.org";

    fn ctx() -> FilterContext {
        FilterContext::new(TODAY)
    }

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
        matches_condition(cell.as_ref(), &op, filter.as_ref(), &ctype, &ctx())
    }

    /// Same as `cond`, but with a viewer for the `@me` sentinel to resolve to.
    fn cond_as(
        me: Option<&str>,
        cell: Option<Value>,
        op: FilterOperator,
        filter: Option<Value>,
        ctype: ColumnType,
    ) -> bool {
        let ctx = ctx().with_me(me.map(String::from));
        matches_condition(cell.as_ref(), &op, filter.as_ref(), &ctype, &ctx)
    }

    #[test]
    fn me_sentinel_resolves_to_the_viewer() {
        use FilterOperator::*;
        // Member: `@me` is whoever is looking.
        assert!(cond_as(
            Some(ALICE),
            Some(json!(ALICE)),
            Equals,
            Some(json!(ME)),
            ColumnType::Member
        ));
        assert!(!cond_as(
            Some("@bob:example.org"),
            Some(json!(ALICE)),
            Equals,
            Some(json!(ME)),
            ColumnType::Member
        ));
        // Inside a list, alongside literal MXIDs.
        assert!(cond_as(
            Some(ALICE),
            Some(json!(ALICE)),
            IsAnyOf,
            Some(json!(["@carol:example.org", ME])),
            ColumnType::Member
        ));
        // MultiMember cells.
        assert!(cond_as(
            Some(ALICE),
            Some(json!(["@bob:example.org", ALICE])),
            HasAnyOf,
            Some(json!([ME])),
            ColumnType::MultiMember
        ));
        assert!(!cond_as(
            Some(ALICE),
            Some(json!(["@bob:example.org"])),
            HasAnyOf,
            Some(json!([ME])),
            ColumnType::MultiMember
        ));
    }

    #[test]
    fn me_is_literal_off_member_columns_and_inert_without_a_viewer() {
        use FilterOperator::*;
        // On a Text column `@me` is just a string — no substitution.
        assert!(cond_as(
            Some(ALICE),
            Some(json!(ME)),
            Equals,
            Some(json!(ME)),
            ColumnType::Text
        ));
        assert!(!cond_as(
            Some(ALICE),
            Some(json!(ALICE)),
            Equals,
            Some(json!(ME)),
            ColumnType::Text
        ));
        // No viewer: `@me` matches nobody rather than everybody.
        assert!(!cond_as(
            None,
            Some(json!(ALICE)),
            Equals,
            Some(json!(ME)),
            ColumnType::Member
        ));
        assert!(!cond_as(
            None,
            Some(json!([ALICE])),
            HasAnyOf,
            Some(json!([ME])),
            ColumnType::MultiMember
        ));
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
    fn this_week_spans_monday_to_sunday() {
        use FilterOperator::*;
        // TODO is Tuesday 2026-07-21, so the week runs 20th (Mon) to 26th (Sun).
        for day in ["2026-07-20", "2026-07-21", "2026-07-26"] {
            assert!(
                cond(Some(json!(day)), IsThisWeek, None, ColumnType::Date),
                "{day} should be in this week"
            );
        }
        for day in ["2026-07-19", "2026-07-27"] {
            assert!(
                !cond(Some(json!(day)), IsThisWeek, None, ColumnType::Date),
                "{day} should be outside this week"
            );
        }
        assert!(!cond(None, IsThisWeek, None, ColumnType::Date));
    }

    #[test]
    fn fixed_span_is_inclusive_at_both_ends() {
        use FilterOperator::*;
        let span = json!({ "moving": false, "from": "2026-03-01", "to": "2026-03-31" });
        for day in ["2026-03-01", "2026-03-15", "2026-03-31"] {
            assert!(cond(
                Some(json!(day)),
                InSpan,
                Some(span.clone()),
                ColumnType::Date
            ));
        }
        for day in ["2026-02-28", "2026-04-01"] {
            assert!(!cond(
                Some(json!(day)),
                InSpan,
                Some(span.clone()),
                ColumnType::Date
            ));
        }
        // Reversed bounds still describe the same span.
        let backwards = json!({ "from": "2026-03-31", "to": "2026-03-01" });
        assert!(cond(
            Some(json!("2026-03-15")),
            InSpan,
            Some(backwards),
            ColumnType::Date
        ));
    }

    #[test]
    fn moving_span_rolls_with_today() {
        use FilterOperator::*;
        // "The last 7 days", relative to TODAY = 2026-07-21.
        let last_week = json!({ "moving": true, "fromDays": -7, "toDays": 0 });
        assert!(cond(
            Some(json!("2026-07-21")),
            InSpan,
            Some(last_week.clone()),
            ColumnType::Date
        ));
        assert!(cond(
            Some(json!("2026-07-14")),
            InSpan,
            Some(last_week.clone()),
            ColumnType::Date
        ));
        assert!(!cond(
            Some(json!("2026-07-13")),
            InSpan,
            Some(last_week.clone()),
            ColumnType::Date
        ));
        // Tomorrow is outside a window that ends today...
        assert!(!cond(
            Some(json!("2026-07-22")),
            InSpan,
            Some(last_week),
            ColumnType::Date
        ));
        // ...and the SAME filter, evaluated a day later, includes it. That's
        // what makes the span "moving".
        let ctx = FilterContext::new("2026-07-22");
        assert!(matches_condition(
            Some(&json!("2026-07-22")),
            &InSpan,
            Some(&json!({ "moving": true, "fromDays": -7, "toDays": 0 })),
            &ColumnType::Date,
            &ctx
        ));
    }

    #[test]
    fn span_arithmetic_crosses_month_and_year_boundaries() {
        use FilterOperator::*;
        let ctx = FilterContext::new("2026-03-01");
        // Three days back from 1 March 2026 reaches 26 February (2026 is not a
        // leap year, so February has 28 days).
        assert!(matches_condition(
            Some(&json!("2026-02-26")),
            &InSpan,
            Some(&json!({ "moving": true, "fromDays": -3, "toDays": 0 })),
            &ColumnType::Date,
            &ctx
        ));
        // A leap year: 1 March 2024 minus 1 day is 29 February.
        let leap = FilterContext::new("2024-03-01");
        assert!(matches_condition(
            Some(&json!("2024-02-29")),
            &InSpan,
            Some(&json!({ "moving": true, "fromDays": -1, "toDays": 0 })),
            &ColumnType::Date,
            &leap
        ));
        // Across new year.
        let ny = FilterContext::new("2026-01-02");
        assert!(matches_condition(
            Some(&json!("2025-12-31")),
            &InSpan,
            Some(&json!({ "moving": true, "fromDays": -2, "toDays": 0 })),
            &ColumnType::Date,
            &ny
        ));
    }

    #[test]
    fn a_malformed_span_matches_nothing() {
        use FilterOperator::*;
        for bad in [
            json!({}),
            json!("2026-01-01"),
            json!({ "from": "2026-01-01" }),
        ] {
            assert!(!cond(
                Some(json!("2026-01-01")),
                InSpan,
                Some(bad),
                ColumnType::Date
            ));
        }
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
        assert!(row_matches(&row("1", "open", 1), &filters, &s, &ctx()));
        assert!(!row_matches(&row("2", "closed", 1), &filters, &s, &ctx()));
        assert!(!row_matches(&row("3", "open", 5), &filters, &s, &ctx()));
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
