//! Fractional indexing for manual ordering — the Rust port of
//! `ui/src/fractionalIndex.ts` (which documents the scheme). Keys are
//! lexicographically-sortable base-62 strings; a key can always be generated
//! strictly between any two, so a move is one `_order` cell write. Keep the two
//! implementations in sync: rows ordered by one must interleave correctly with
//! keys minted by the other.

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn digit_index(c: u8) -> usize {
    DIGITS
        .iter()
        .position(|&d| d == c)
        .expect("non-base62 digit in order key")
}

/// A string strictly between `a` and `b` (`a < b`; `b = None` means +∞).
/// Mirrors the TS `midpoint` exactly, including its rounding.
fn midpoint(a: &str, b: Option<&str>) -> String {
    let zero = DIGITS[0] as char;
    if let Some(b) = b {
        assert!(a < b, "fractional index: {a} >= {b}");
    }
    if a.ends_with(zero) || b.is_some_and(|b| b.ends_with(zero)) {
        panic!("fractional index: unexpected trailing zero");
    }
    if let Some(b) = b {
        // Strip the longest common prefix (padding `a` with zeros past its end).
        let ab = a.as_bytes();
        let bb = b.as_bytes();
        let mut n = 0;
        while n < bb.len() && *ab.get(n).unwrap_or(&DIGITS[0]) == bb[n] {
            n += 1;
        }
        if n > 0 {
            let a_rest = if n < a.len() { &a[n..] } else { "" };
            return format!("{}{}", &b[..n], midpoint(a_rest, Some(&b[n..])));
        }
    }
    let digit_a = if a.is_empty() {
        0
    } else {
        digit_index(a.as_bytes()[0])
    };
    let digit_b = b.map_or(DIGITS.len(), |b| digit_index(b.as_bytes()[0]));
    if digit_b - digit_a > 1 {
        // JS Math.round(0.5 * (a + b)) = round-half-up on the midpoint.
        let mid = (digit_a + digit_b).div_ceil(2);
        return (DIGITS[mid] as char).to_string();
    }
    // First digits are consecutive.
    if let Some(b) = b {
        if b.len() > 1 {
            return (b.as_bytes()[0] as char).to_string();
        }
    }
    let a_rest = if a.is_empty() { "" } else { &a[1..] };
    format!("{}{}", DIGITS[digit_a] as char, midpoint(a_rest, None))
}

/// Generate a key that sorts strictly between `a` and `b`. `None` = unbounded.
pub fn generate_key_between(a: Option<&str>, b: Option<&str>) -> String {
    if let (Some(a), Some(b)) = (a, b) {
        assert!(a < b, "fractional index: {a} >= {b}");
    }
    midpoint(a.unwrap_or(""), b)
}

/// Generate `n` keys in ascending order strictly between `a` and `b`.
pub fn generate_n_keys_between(a: Option<&str>, b: Option<&str>, n: usize) -> Vec<String> {
    match n {
        0 => Vec::new(),
        1 => vec![generate_key_between(a, b)],
        _ => match (a, b) {
            (_, None) => {
                let mut out = vec![generate_key_between(a, None)];
                for _ in 1..n {
                    let next = generate_key_between(Some(out.last().unwrap()), None);
                    out.push(next);
                }
                out
            }
            (None, Some(_)) => {
                let mut out = vec![generate_key_between(None, b)];
                for _ in 1..n {
                    let next = generate_key_between(None, Some(out.last().unwrap()));
                    out.push(next);
                }
                out.reverse();
                out
            }
            (Some(_), Some(_)) => {
                let mid = n / 2;
                let c = generate_key_between(a, b);
                let mut out = generate_n_keys_between(a, Some(&c), mid);
                out.push(c.clone());
                out.extend(generate_n_keys_between(Some(&c), b, n - mid - 1));
                out
            }
        },
    }
}

/// Where a `move` puts the row/column relative to the current order.
pub enum MovePosition {
    First,
    Last,
    Before(String),
    After(String),
}

/// Compute the `_order` writes to move `id` to `position` within `rows`
/// (id, current key) listed in current display order. Single write when every
/// row already has a key; otherwise backfills the whole order (the same
/// one-time O(n) cost as the UI's `computeReorderWrites`).
pub fn compute_move_writes(
    rows: &[(String, Option<String>)],
    id: &str,
    position: &MovePosition,
) -> Result<Vec<(String, String)>, String> {
    let from = rows
        .iter()
        .position(|(rid, _)| rid == id)
        .ok_or_else(|| format!("no row/column {id:?} to move"))?;

    let mut reordered: Vec<&(String, Option<String>)> = rows.iter().collect();
    let moved = reordered.remove(from);
    let to = match position {
        MovePosition::First => 0,
        MovePosition::Last => reordered.len(),
        MovePosition::Before(target) | MovePosition::After(target) => {
            if *target == *id {
                return Err(format!("cannot move {id:?} relative to itself"));
            }
            let t = reordered
                .iter()
                .position(|(rid, _)| rid == target)
                .ok_or_else(|| format!("no row/column {target:?} to anchor the move"))?;
            if matches!(position, MovePosition::Before(_)) {
                t
            } else {
                t + 1
            }
        }
    };
    reordered.insert(to, moved);

    if rows.iter().all(|(_, k)| k.is_some()) {
        let prev = to.checked_sub(1).and_then(|i| reordered[i].1.as_deref());
        let next = reordered.get(to + 1).and_then(|(_, k)| k.as_deref());
        return Ok(vec![(id.to_string(), generate_key_between(prev, next))]);
    }
    let keys = generate_n_keys_between(None, None, reordered.len());
    Ok(reordered
        .into_iter()
        .zip(keys)
        .map(|((rid, _), key)| (rid.clone(), key))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Values cross-checked against the TS implementation
    // (ui/src/fractionalIndex.ts) — the two must interleave.
    #[test]
    fn matches_ts_reference_outputs() {
        assert_eq!(generate_key_between(None, None), "V");
        assert_eq!(generate_key_between(Some("V"), None), "l");
        assert_eq!(generate_key_between(None, Some("V")), "G");
        assert_eq!(generate_key_between(Some("V"), Some("l")), "d");
        assert_eq!(generate_key_between(Some("V"), Some("W")), "VV");
        assert_eq!(generate_key_between(Some("VV"), Some("W")), "Vl");
    }

    #[test]
    fn generated_keys_sort_between_bounds() {
        let mut prev = generate_key_between(None, None);
        for _ in 0..50 {
            let next = generate_key_between(Some(&prev), None);
            assert!(next > prev);
            prev = next;
        }
        let mut hi = generate_key_between(None, None);
        for _ in 0..50 {
            let lo = generate_key_between(None, Some(&hi));
            assert!(lo < hi);
            hi = lo;
        }
    }

    #[test]
    fn n_keys_are_ascending_and_bounded() {
        let keys = generate_n_keys_between(None, None, 10);
        assert_eq!(keys.len(), 10);
        for w in keys.windows(2) {
            assert!(w[0] < w[1]);
        }
        let inner = generate_n_keys_between(Some(&keys[2]), Some(&keys[3]), 5);
        for k in &inner {
            assert!(*k > keys[2] && *k < keys[3]);
        }
    }

    fn keyed(rows: &[(&str, &str)]) -> Vec<(String, Option<String>)> {
        rows.iter()
            .map(|(id, k)| (id.to_string(), Some(k.to_string())))
            .collect()
    }

    #[test]
    fn move_with_full_keys_writes_only_the_moved_row() {
        let rows = keyed(&[("a", "F"), ("b", "V"), ("c", "l")]);
        let w = compute_move_writes(&rows, "c", &MovePosition::First).unwrap();
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].0, "c");
        assert!(w[0].1.as_str() < "F");

        let w = compute_move_writes(&rows, "a", &MovePosition::After("b".into())).unwrap();
        assert_eq!(w.len(), 1);
        assert!(w[0].1.as_str() > "V" && w[0].1.as_str() < "l");

        let w = compute_move_writes(&rows, "a", &MovePosition::Last).unwrap();
        assert_eq!(w.len(), 1);
        assert!(w[0].1.as_str() > "l");
    }

    #[test]
    fn move_backfills_when_keys_are_missing() {
        let rows = vec![
            ("a".to_string(), None),
            ("b".to_string(), Some("V".to_string())),
            ("c".to_string(), None),
        ];
        let w = compute_move_writes(&rows, "c", &MovePosition::Before("a".into())).unwrap();
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].0, "c");
        assert_eq!(w[1].0, "a");
        assert_eq!(w[2].0, "b");
        assert!(w[0].1 < w[1].1 && w[1].1 < w[2].1);
    }

    #[test]
    fn move_errors_are_descriptive() {
        let rows = keyed(&[("a", "F"), ("b", "V")]);
        assert!(compute_move_writes(&rows, "ghost", &MovePosition::First).is_err());
        assert!(compute_move_writes(&rows, "a", &MovePosition::Before("ghost".into())).is_err());
        assert!(compute_move_writes(&rows, "a", &MovePosition::After("a".into())).is_err());
    }
}
