/**
 * Fractional indexing for manual row ordering (#12).
 *
 * Keys are lexicographically-sortable base-62 strings. You can always generate
 * a key strictly between any two keys (or before/after all), so reordering a row
 * is a single `_order` cell write with no neighbour rewrites. Merge is trivial
 * and self-healing under LWW: sort by key, tie-break by row id.
 *
 * The midpoint algorithm is adapted from rocicorp/fractional-indexing (MIT). We
 * use the pure-fractional variant (no integer header): keys are treated as the
 * fraction `0.<key>` in base 62. That keeps the code small; keys grow a little
 * faster under repeated prepend, which is irrelevant at table scale.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** A string strictly between `a` and `b` (a < b; b === null means +∞). */
function midpoint(a: string, b: string | null): string {
  const zero = DIGITS[0]
  if (b !== null && a >= b) throw new Error(`fractional index: ${a} >= ${b}`)
  if (a.slice(-1) === zero || (b !== null && b.slice(-1) === zero)) {
    throw new Error('fractional index: unexpected trailing zero')
  }
  if (b !== null) {
    // Strip the longest common prefix (padding `a` with zeros past its end).
    let n = 0
    while ((a[n] ?? zero) === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length
  if (digitB - digitA > 1) {
    return DIGITS[Math.round(0.5 * (digitA + digitB))]
  }
  // First digits are consecutive.
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[digitA] + midpoint(a.slice(1), null)
}

/** Generate a key that sorts strictly between `a` and `b`. `null` = unbounded. */
export function generateKeyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    throw new Error(`fractional index: ${a} >= ${b}`)
  }
  return midpoint(a ?? '', b)
}

/** Generate `n` keys in ascending order strictly between `a` and `b`. */
export function generateNKeysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return []
  if (n === 1) return [generateKeyBetween(a, b)]
  if (b === null) {
    let prev = generateKeyBetween(a, null)
    const out = [prev]
    for (let i = 1; i < n; i++) {
      prev = generateKeyBetween(prev, null)
      out.push(prev)
    }
    return out
  }
  if (a === null) {
    let next = generateKeyBetween(null, b)
    const out = [next]
    for (let i = 1; i < n; i++) {
      next = generateKeyBetween(null, next)
      out.push(next)
    }
    out.reverse()
    return out
  }
  const mid = Math.floor(n / 2)
  const c = generateKeyBetween(a, b)
  return [...generateNKeysBetween(a, c, mid), c, ...generateNKeysBetween(c, b, n - mid - 1)]
}

function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const copy = arr.slice()
  const [item] = copy.splice(from, 1)
  copy.splice(to, 0, item)
  return copy
}

export interface OrderRow {
  id: string
  /** Current `_order` key, or null if the row has never been manually ordered. */
  key: string | null
}

/**
 * Compute the `_order` cell writes to move `activeId` to where `overId` sits,
 * within the currently-ordered `rows`.
 *
 * If every row already has a key, this returns a single write (the moved row);
 * otherwise it backfills keys for all rows in the new order — a one-time O(n)
 * cost on the first manual reorder of a table.
 */
export function computeReorderWrites(
  rows: OrderRow[],
  activeId: string,
  overId: string,
): Array<{ id: string; key: string }> {
  const from = rows.findIndex(r => r.id === activeId)
  const to = rows.findIndex(r => r.id === overId)
  if (from === -1 || to === -1 || from === to) return []

  const reordered = arrayMove(rows, from, to)

  if (rows.every(r => r.key != null)) {
    const idx = reordered.findIndex(r => r.id === activeId)
    const prev = idx > 0 ? reordered[idx - 1].key : null
    const next = idx < reordered.length - 1 ? reordered[idx + 1].key : null
    return [{ id: activeId, key: generateKeyBetween(prev, next) }]
  }

  const keys = generateNKeysBetween(null, null, reordered.length)
  return reordered.map((r, i) => ({ id: r.id, key: keys[i] }))
}
