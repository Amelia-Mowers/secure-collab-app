//! Formulas over a row: `first_name + " " + last_name`.
//!
//! # Why real Typst syntax, but not the Typst compiler
//!
//! Formulas are written in **Typst code syntax** and parsed by `typst-syntax`,
//! the upstream parser. Evaluation of the supported subset happens here.
//!
//! `typst-eval` — the real evaluator — was measured and rejected for now: it
//! depends on `typst-library` (Typst's entire standard library, including
//! layout and font types) and on `stacker`, which grows the stack by platform
//! tricks that do not fit wasm. The bundle is already 10.7 MB. `typst-syntax`
//! by contrast is standalone: unicode tables, `ecow`, `unscanny`.
//!
//! The payoff of parsing with the real thing is that **stored formulas are
//! already valid Typst**. Growing into full Typst later means swapping this
//! evaluator for `typst-eval`; no formula anyone has written needs migrating,
//! and no bespoke grammar has to be kept compatible. Anything outside the
//! subset gets a clean "not supported yet" rather than a parse error, so the
//! boundary is visible to users and moves outward without breaking them.
//!
//! # Why evaluation is at READ time
//!
//! Nothing is ever written back. A formula cell is computed from its row each
//! time the row is read (see `Workspace::get_table_rows`), exactly like
//! read-time select defaults. Materializing results would fight last-writer-
//! wins: two devices computing from different in-flight states would each write
//! a "correct" answer and clobber each other, and a formula edit would need a
//! mass rewrite of every row. Computing on read makes a formula change take
//! effect everywhere at once, with no writes at all.
//!
//! # Reusable over a row, not a column feature
//!
//! [`evaluate`] takes a formula and a row and returns a value. The formula
//! column type is one caller. The reference display function (issue c14e01a0)
//! is meant to be another: rendering a referenced row's label is the same
//! operation — a formula evaluated against a row.

use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use typst_syntax::ast::{self, AstNode};

/// Why a formula did not produce a value.
///
/// Rendered into the cell rather than thrown away: a silent blank in a computed
/// column is indistinguishable from "no data", and the user cannot tell that
/// their formula is wrong.
#[derive(Debug, Clone, PartialEq)]
pub enum FormulaError {
    /// The text is not syntactically valid Typst.
    Syntax(String),
    /// Valid Typst, but outside the subset this evaluator implements.
    Unsupported(String),
    /// A referenced column does not exist in this table.
    UnknownColumn(String),
    /// Types that cannot combine, e.g. a number minus a string.
    Type(String),
}

impl fmt::Display for FormulaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Syntax(m) => write!(f, "#syntax: {m}"),
            Self::Unsupported(m) => write!(f, "#unsupported: {m}"),
            Self::UnknownColumn(m) => write!(f, "#no column: {m}"),
            Self::Type(m) => write!(f, "#type: {m}"),
        }
    }
}

/// A value while a formula is being evaluated.
#[derive(Debug, Clone, PartialEq)]
enum Val {
    Str(String),
    Num(f64),
    Bool(bool),
    /// An empty cell. Concatenating with it yields the other side, so
    /// `first + " " + last` on a row with no middle name does not leave gaps.
    Blank,
}

impl Val {
    fn from_json(v: &Value) -> Self {
        match v {
            Value::Null => Self::Blank,
            Value::Bool(b) => Self::Bool(*b),
            Value::Number(n) => n.as_f64().map(Self::Num).unwrap_or(Self::Blank),
            Value::String(s) if s.is_empty() => Self::Blank,
            Value::String(s) => Self::Str(s.clone()),
            // Arrays (multiselect, multi-reference) render comma-joined, which
            // is how they already read elsewhere in the app.
            Value::Array(a) => {
                let joined = a
                    .iter()
                    .filter_map(|x| match x {
                        Value::String(s) => Some(s.clone()),
                        Value::Number(n) => Some(n.to_string()),
                        Value::Bool(b) => Some(b.to_string()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                if joined.is_empty() {
                    Self::Blank
                } else {
                    Self::Str(joined)
                }
            }
            Value::Object(_) => Self::Blank,
        }
    }

    fn into_json(self) -> Value {
        match self {
            Self::Str(s) => Value::String(s),
            Self::Num(n) => serde_json::Number::from_f64(n)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            Self::Bool(b) => Value::Bool(b),
            Self::Blank => Value::Null,
        }
    }

    /// Text form used when a value lands in a string context.
    fn to_text(&self) -> String {
        match self {
            Self::Str(s) => s.clone(),
            // Whole floats print as integers: a count reads "3", not "3".
            Self::Num(n) if n.fract() == 0.0 && n.is_finite() => format!("{}", *n as i64),
            Self::Num(n) => n.to_string(),
            Self::Bool(b) => b.to_string(),
            Self::Blank => String::new(),
        }
    }

    fn as_num(&self) -> Option<f64> {
        match self {
            Self::Num(n) => Some(*n),
            // Blank is 0 in arithmetic so a missing number does not poison a sum.
            Self::Blank => Some(0.0),
            _ => None,
        }
    }

    fn truthy(&self) -> bool {
        match self {
            Self::Bool(b) => *b,
            Self::Num(n) => *n != 0.0,
            Self::Str(s) => !s.is_empty(),
            Self::Blank => false,
        }
    }
}

/// Evaluate `formula` against one row.
///
/// `row` is keyed by column id; `columns` maps a column's display name to its
/// id, so formulas can be written against names (what a user types) while the
/// stored reference stays stable if the column is renamed... which it does not
/// yet — see the note in [`lookup`].
pub fn evaluate(
    formula: &str,
    row: &HashMap<String, Value>,
    columns: &HashMap<String, String>,
) -> Result<Value, FormulaError> {
    let root = typst_syntax::parse_code(formula);
    let (errors, _warnings) = root.errors_and_warnings();
    if let Some(err) = errors.first() {
        return Err(FormulaError::Syntax(err.message.to_string()));
    }
    // `parse_code` yields a Code node holding the expressions; a formula is a
    // single expression, so take the first one.
    let code = root
        .cast::<ast::Code>()
        .ok_or_else(|| FormulaError::Syntax("not an expression".into()))?;
    let expr = code
        .exprs()
        .next()
        .ok_or_else(|| FormulaError::Syntax("empty formula".into()))?;
    Ok(eval_expr(expr, row, columns)?.into_json())
}

fn eval_expr(
    expr: ast::Expr,
    row: &HashMap<String, Value>,
    columns: &HashMap<String, String>,
) -> Result<Val, FormulaError> {
    match expr {
        ast::Expr::Str(s) => Ok(Val::Str(s.get().to_string())),
        ast::Expr::Int(i) => Ok(Val::Num(i.get() as f64)),
        ast::Expr::Float(f) => Ok(Val::Num(f.get())),
        ast::Expr::Bool(b) => Ok(Val::Bool(b.get())),
        ast::Expr::Ident(id) => lookup(id.get(), row, columns),
        ast::Expr::Parenthesized(p) => eval_expr(p.expr(), row, columns),
        // `if cond { a } else { b }` — the branches are code blocks. A block
        // evaluates to its last expression, as in Typst.
        ast::Expr::CodeBlock(block) => {
            let mut last = Val::Blank;
            for e in block.body().exprs() {
                last = eval_expr(e, row, columns)?;
            }
            Ok(last)
        }
        ast::Expr::Unary(u) => {
            let v = eval_expr(u.expr(), row, columns)?;
            match u.op() {
                ast::UnOp::Pos => num_of(&v).map(Val::Num),
                ast::UnOp::Neg => num_of(&v).map(|n| Val::Num(-n)),
                ast::UnOp::Not => Ok(Val::Bool(!v.truthy())),
            }
        }
        ast::Expr::Binary(b) => eval_binary(b, row, columns),
        ast::Expr::FuncCall(call) => eval_call(call, row, columns),
        ast::Expr::Conditional(c) => {
            let cond = eval_expr(c.condition(), row, columns)?;
            if cond.truthy() {
                eval_expr(c.if_body(), row, columns)
            } else {
                match c.else_body() {
                    Some(e) => eval_expr(e, row, columns),
                    None => Ok(Val::Blank),
                }
            }
        }
        other => Err(FormulaError::Unsupported(format!(
            "{:?} expressions",
            other.to_untyped().kind()
        ))),
    }
}

/// Resolve an identifier to a cell value.
///
/// Columns are referenced by **id** — `first_name`, not `First name`. That is
/// forced by the syntax: a display name with a space is two identifiers to any
/// parser, so names could never be written bare. Ids are the identifier-shaped
/// half of a column anyway (the UI derives them by lowercasing the name and
/// replacing spaces with underscores), and they survive a rename, which a name
/// reference could not.
///
/// A display NAME still resolves when it happens to be identifier-shaped
/// (`email`, `company`), since then there is no ambiguity and it is what a user
/// would type.
fn lookup(
    ident: &str,
    row: &HashMap<String, Value>,
    columns: &HashMap<String, String>,
) -> Result<Val, FormulaError> {
    // By id first: stable across renames.
    if columns.values().any(|id| id == ident) || row.contains_key(ident) {
        return Ok(row.get(ident).map(Val::from_json).unwrap_or(Val::Blank));
    }
    // Then by display name, for the identifier-shaped ones.
    if let Some(id) = columns.get(ident) {
        return Ok(row.get(id).map(Val::from_json).unwrap_or(Val::Blank));
    }
    Err(FormulaError::UnknownColumn(ident.to_string()))
}

fn num_of(v: &Val) -> Result<f64, FormulaError> {
    v.as_num()
        .ok_or_else(|| FormulaError::Type(format!("{} is not a number", v.to_text())))
}

fn eval_binary(
    b: ast::Binary,
    row: &HashMap<String, Value>,
    columns: &HashMap<String, String>,
) -> Result<Val, FormulaError> {
    use ast::BinOp;
    let op = b.op();

    // Short-circuit before evaluating the right side, as Typst does.
    if matches!(op, BinOp::And | BinOp::Or) {
        let lhs = eval_expr(b.lhs(), row, columns)?;
        let lt = lhs.truthy();
        if (op == BinOp::And && !lt) || (op == BinOp::Or && lt) {
            return Ok(Val::Bool(lt));
        }
        return Ok(Val::Bool(eval_expr(b.rhs(), row, columns)?.truthy()));
    }

    let lhs = eval_expr(b.lhs(), row, columns)?;
    let rhs = eval_expr(b.rhs(), row, columns)?;

    match op {
        BinOp::Add => match (&lhs, &rhs) {
            // Blank + Blank stays blank, so an all-empty row yields an empty
            // cell rather than the string "".
            (Val::Blank, Val::Blank) => Ok(Val::Blank),
            (Val::Num(a), Val::Num(b)) => Ok(Val::Num(a + b)),
            // A blank beside a number is arithmetic; beside text it is
            // concatenation. This is what makes `first + " " + middle + " " +
            // last` collapse cleanly when the middle name is missing.
            (Val::Num(a), Val::Blank) => Ok(Val::Num(*a)),
            (Val::Blank, Val::Num(b)) => Ok(Val::Num(*b)),
            _ => Ok(Val::Str(format!("{}{}", lhs.to_text(), rhs.to_text()))),
        },
        BinOp::Sub => Ok(Val::Num(num_of(&lhs)? - num_of(&rhs)?)),
        BinOp::Mul => Ok(Val::Num(num_of(&lhs)? * num_of(&rhs)?)),
        BinOp::Div => {
            let d = num_of(&rhs)?;
            if d == 0.0 {
                return Err(FormulaError::Type("division by zero".into()));
            }
            Ok(Val::Num(num_of(&lhs)? / d))
        }
        BinOp::Eq => Ok(Val::Bool(equal(&lhs, &rhs))),
        BinOp::Neq => Ok(Val::Bool(!equal(&lhs, &rhs))),
        BinOp::Lt => cmp(&lhs, &rhs, |o| o.is_lt()),
        BinOp::Leq => cmp(&lhs, &rhs, |o| o.is_le()),
        BinOp::Gt => cmp(&lhs, &rhs, |o| o.is_gt()),
        BinOp::Geq => cmp(&lhs, &rhs, |o| o.is_ge()),
        other => Err(FormulaError::Unsupported(format!("the {other:?} operator"))),
    }
}

fn equal(a: &Val, b: &Val) -> bool {
    match (a, b) {
        (Val::Num(x), Val::Num(y)) => x == y,
        (Val::Blank, Val::Blank) => true,
        (Val::Bool(x), Val::Bool(y)) => x == y,
        _ => a.to_text() == b.to_text(),
    }
}

fn cmp(a: &Val, b: &Val, ok: impl Fn(std::cmp::Ordering) -> bool) -> Result<Val, FormulaError> {
    let ord = match (a, b) {
        (Val::Num(x), Val::Num(y)) => x
            .partial_cmp(y)
            .ok_or_else(|| FormulaError::Type("cannot compare NaN".into()))?,
        _ => a.to_text().cmp(&b.to_text()),
    };
    Ok(Val::Bool(ok(ord)))
}

/// The supported function subset. Deliberately small: these are the ones the
/// name-joining and tidy-up cases actually need.
fn eval_call(
    call: ast::FuncCall,
    row: &HashMap<String, Value>,
    columns: &HashMap<String, String>,
) -> Result<Val, FormulaError> {
    let name = match call.callee() {
        ast::Expr::Ident(id) => id.get().to_string(),
        other => {
            return Err(FormulaError::Unsupported(format!(
                "calling {:?}",
                other.to_untyped().kind()
            )))
        }
    };

    let mut args = Vec::new();
    for arg in call.args().items() {
        match arg {
            ast::Arg::Pos(e) => args.push(eval_expr(e, row, columns)?),
            _ => return Err(FormulaError::Unsupported("named arguments".into())),
        }
    }

    let need = |n: usize| -> Result<(), FormulaError> {
        if args.len() == n {
            Ok(())
        } else {
            Err(FormulaError::Type(format!(
                "{name} takes {n} argument(s), got {}",
                args.len()
            )))
        }
    };

    match name.as_str() {
        "upper" => need(1).map(|_| Val::Str(args[0].to_text().to_uppercase())),
        "lower" => need(1).map(|_| Val::Str(args[0].to_text().to_lowercase())),
        "str" => need(1).map(|_| Val::Str(args[0].to_text())),
        "len" => need(1).map(|_| Val::Num(args[0].to_text().chars().count() as f64)),
        "trim" => need(1).map(|_| {
            let t = args[0].to_text().trim().to_string();
            if t.is_empty() {
                Val::Blank
            } else {
                Val::Str(t)
            }
        }),
        // Joins the non-blank arguments with the first one as separator, which
        // is the whole "full name from parts" case in one call.
        "join" => {
            if args.len() < 2 {
                return Err(FormulaError::Type(
                    "join takes a separator and values".into(),
                ));
            }
            let sep = args[0].to_text();
            let parts: Vec<String> = args[1..]
                .iter()
                .filter(|v| !matches!(v, Val::Blank))
                .map(|v| v.to_text())
                .filter(|s| !s.trim().is_empty())
                .collect();
            Ok(if parts.is_empty() {
                Val::Blank
            } else {
                Val::Str(parts.join(&sep))
            })
        }
        other => Err(FormulaError::Unsupported(format!("the `{other}` function"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cols(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(n, i)| (n.to_string(), i.to_string()))
            .collect()
    }

    fn row(pairs: &[(&str, Value)]) -> HashMap<String, Value> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    fn eval(f: &str, r: &HashMap<String, Value>, c: &HashMap<String, String>) -> Value {
        evaluate(f, r, c).unwrap()
    }

    #[test]
    fn concatenates_name_parts() {
        let c = cols(&[("first", "c1"), ("last", "c2")]);
        let r = row(&[("c1", json!("Ada")), ("c2", json!("Lovelace"))]);
        assert_eq!(eval(r#"first + " " + last"#, &r, &c), json!("Ada Lovelace"));
    }

    #[test]
    fn join_skips_a_missing_middle_name() {
        let c = cols(&[("first", "c1"), ("middle", "c2"), ("last", "c3")]);
        let full = row(&[
            ("c1", json!("Ada")),
            ("c2", json!("Byron")),
            ("c3", json!("Lovelace")),
        ]);
        assert_eq!(
            eval(r#"join(" ", first, middle, last)"#, &full, &c),
            json!("Ada Byron Lovelace")
        );

        // The case that motivates `join` over `+`: no double space.
        let no_middle = row(&[
            ("c1", json!("Ada")),
            ("c2", json!("")),
            ("c3", json!("Lovelace")),
        ]);
        assert_eq!(
            eval(r#"join(" ", first, middle, last)"#, &no_middle, &c),
            json!("Ada Lovelace")
        );
    }

    #[test]
    fn blank_plus_blank_stays_blank() {
        let c = cols(&[("first", "c1"), ("last", "c2")]);
        let r = row(&[]);
        assert_eq!(eval("first + last", &r, &c), json!(null));
    }

    #[test]
    fn arithmetic_treats_blank_as_zero() {
        let c = cols(&[("qty", "c1"), ("price", "c2")]);
        let r = row(&[("c1", json!(3)), ("c2", json!(2.5))]);
        assert_eq!(eval("qty * price", &r, &c), json!(7.5));
        let missing = row(&[("c1", json!(3))]);
        assert_eq!(eval("qty + price", &missing, &c), json!(3.0));
    }

    #[test]
    fn whole_numbers_render_without_a_decimal_point() {
        let c = cols(&[("n", "c1")]);
        let r = row(&[("c1", json!(4))]);
        assert_eq!(eval(r##""#" + n"##, &r, &c), json!("#4"));
    }

    #[test]
    fn conditionals_and_comparisons() {
        let c = cols(&[("score", "c1")]);
        let r = row(&[("c1", json!(75))]);
        assert_eq!(
            eval(r#"if score >= 50 { "pass" } else { "fail" }"#, &r, &c),
            json!("pass")
        );
    }

    #[test]
    fn string_helpers() {
        let c = cols(&[("name", "c1")]);
        let r = row(&[("c1", json!("  ada  "))]);
        assert_eq!(eval("upper(trim(name))", &r, &c), json!("ADA"));
        assert_eq!(eval("len(trim(name))", &r, &c), json!(3.0));
    }

    #[test]
    fn arrays_render_comma_joined() {
        let c = cols(&[("tags", "c1")]);
        let r = row(&[("c1", json!(["red", "blue"]))]);
        assert_eq!(eval("tags", &r, &c), json!("red, blue"));
    }

    #[test]
    fn columns_resolve_by_id_and_by_identifier_shaped_name() {
        // The id always works — this is what a display name with a space
        // forces, since `First name` would parse as two identifiers.
        let c = cols(&[("First name", "first_name")]);
        let r = row(&[("first_name", json!("Ada"))]);
        assert_eq!(eval("first_name", &r, &c), json!("Ada"));

        // A name that is already identifier-shaped resolves too.
        let c2 = cols(&[("email", "c9")]);
        let r2 = row(&[("c9", json!("ada@example.test"))]);
        assert_eq!(eval("email", &r2, &c2), json!("ada@example.test"));
    }

    #[test]
    fn unknown_column_is_named_in_the_error() {
        let c = cols(&[("first", "c1")]);
        let r = row(&[]);
        assert_eq!(
            evaluate("nope", &r, &c),
            Err(FormulaError::UnknownColumn("nope".into()))
        );
    }

    #[test]
    fn syntax_errors_are_reported_as_syntax() {
        let c = cols(&[]);
        let r = row(&[]);
        assert!(matches!(
            evaluate(r#""unterminated"#, &r, &c),
            Err(FormulaError::Syntax(_))
        ));
    }

    #[test]
    fn unsupported_typst_parses_but_is_refused_clearly() {
        // Valid Typst the evaluator does not implement. It must NOT read as a
        // syntax error — the distinction is what makes the subset boundary
        // legible, and what lets it move outward later.
        let c = cols(&[]);
        let r = row(&[]);
        assert!(matches!(
            evaluate("for x in (1, 2) { x }", &r, &c),
            Err(FormulaError::Unsupported(_))
        ));
    }

    #[test]
    fn division_by_zero_is_an_error_not_infinity() {
        let c = cols(&[("a", "c1")]);
        let r = row(&[("c1", json!(1))]);
        assert!(matches!(
            evaluate("a / 0", &r, &c),
            Err(FormulaError::Type(_))
        ));
    }
}
