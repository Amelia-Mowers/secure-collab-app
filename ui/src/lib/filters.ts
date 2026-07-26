/**
 * Client-side filter engine for table views.
 *
 * A view holds a list of {@link FilterCondition}s; {@link applyFilters} keeps the
 * rows where EVERY condition matches (AND). The UI builds the editor from
 * {@link operatorsForType} (which operators a column type offers, with labels)
 * and {@link operatorNeedsValue} (whether to render a value input), and previews
 * a single comparison with {@link matchesCondition}.
 *
 * Cell value shapes by column type: text/document = string; number = number;
 * boolean = boolean; date = ISO `YYYY-MM-DD`; select/reference = string | null;
 * multiselect = string[]; json = arbitrary. member = MXID string; multimember =
 * MXID string[]. "Empty" means `null`, `undefined`, `''`, or an empty array.
 *
 * Dynamic values (`is_today`, the {@link ME} sentinel) resolve against a
 * {@link FilterContext} at evaluation time, never at save time — so one saved
 * "assigned to me" view means something different, and correct, for each
 * viewer. `crates/app-core/src/filter_eval.rs` mirrors this; keep them in sync.
 */

export type FilterOp =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'greater_than'
  | 'greater_than_or_equal'
  | 'less_than'
  | 'less_than_or_equal'
  | 'is_any_of'
  | 'has_any_of'
  | 'has_all_of'
  | 'has_none_of'
  | 'is_today'
  | 'is_this_week'
  | 'in_span'
  | 'is_empty'
  | 'is_not_empty'

export interface FilterCondition {
  columnId: string
  operator: FilterOp
  /** Omitted/undefined for is_empty / is_not_empty / is_today. */
  value?: unknown
}

/**
 * The filter value standing for "whoever is looking", on member columns.
 * Saved verbatim in the view; resolved per-viewer via {@link FilterContext.me}.
 * Not a valid MXID (those are `@localpart:server`), so it can't collide.
 */
export const ME = '@me'

/** Caller-supplied values for the operators that depend on who/when. */
export interface FilterContext {
  /** The viewer's MXID. Absent → {@link ME} matches nobody (never everybody). */
  me?: string | null
  /** Override for "today" as `YYYY-MM-DD`; defaults to the local calendar day. */
  today?: string
}

export interface FilterColumn {
  id: string
  /** 'text'|'number'|'boolean'|'date'|'select'|'multiselect'|'reference'|'document'|'json' */
  column_type: string
}

interface OperatorOption {
  op: FilterOp
  label: string
}

/** Operators that need no value input — shared so the lists stay DRY. */
const EMPTY_OPS: OperatorOption[] = [
  { op: 'is_empty', label: 'is empty' },
  { op: 'is_not_empty', label: 'is not empty' },
]

/** Operators that carry no value (the editor renders no value input for these). */
const NO_VALUE_OPS: ReadonlySet<FilterOp> = new Set<FilterOp>([
  'is_empty',
  'is_not_empty',
  'is_today',
  'is_this_week',
])

/**
 * The value an `in_span` filter carries.
 *
 * A fixed span is two calendar dates. A MOVING span is day offsets either side
 * of today, so "the last 7 days" still means the last 7 days tomorrow — that's
 * the distinction the moving toggle expresses, and why the offsets are stored
 * rather than the dates they currently resolve to.
 */
export interface SpanValue {
  moving?: boolean
  /** moving: false */
  from?: string
  to?: string
  /** moving: true — days relative to today, negative for the past. */
  fromDays?: number
  toDays?: number
}

/** Operators offered for a column type, with UI labels, in display order. */
export function operatorsForType(columnType: string): OperatorOption[] {
  switch (columnType) {
    case 'text':
    case 'document':
      return [
        { op: 'contains', label: 'contains' },
        { op: 'not_contains', label: 'does not contain' },
        { op: 'equals', label: 'is' },
        { op: 'not_equals', label: 'is not' },
        ...EMPTY_OPS,
      ]
    case 'number':
      return [
        { op: 'equals', label: '=' },
        { op: 'not_equals', label: '≠' },
        { op: 'greater_than', label: '>' },
        { op: 'greater_than_or_equal', label: '≥' },
        { op: 'less_than', label: '<' },
        { op: 'less_than_or_equal', label: '≤' },
        ...EMPTY_OPS,
      ]
    case 'date':
      return [
        { op: 'equals', label: 'is' },
        { op: 'not_equals', label: 'is not' },
        { op: 'less_than', label: 'is before' },
        { op: 'less_than_or_equal', label: 'is on or before' },
        { op: 'greater_than', label: 'is after' },
        { op: 'greater_than_or_equal', label: 'is on or after' },
        { op: 'is_today', label: 'is today' },
        { op: 'is_this_week', label: 'is this week' },
        { op: 'in_span', label: 'is within' },
        ...EMPTY_OPS,
      ]
    case 'boolean':
      return [
        { op: 'equals', label: 'is' },
        { op: 'is_empty', label: 'is unset' },
        { op: 'is_not_empty', label: 'is set' },
      ]
    case 'select':
    case 'member':
    case 'reference':
      return [
        { op: 'equals', label: 'is' },
        { op: 'not_equals', label: 'is not' },
        { op: 'is_any_of', label: 'is any of' },
        ...EMPTY_OPS,
      ]
    case 'multiselect':
    case 'multimember':
    case 'multireference':
      return [
        { op: 'has_any_of', label: 'has any of' },
        { op: 'has_all_of', label: 'has all of' },
        { op: 'has_none_of', label: 'has none of' },
        ...EMPTY_OPS,
      ]
    case 'json':
    default:
      return [
        ...EMPTY_OPS,
        { op: 'equals', label: 'is' },
        { op: 'not_equals', label: 'is not' },
      ]
  }
}

/** False for is_empty / is_not_empty / is_today (no value input needed). */
export function operatorNeedsValue(op: FilterOp): boolean {
  return !NO_VALUE_OPS.has(op)
}

/** Empty = null, undefined, '', or an empty array. */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

/** Today's local calendar date as `YYYY-MM-DD`. Computed per-call (never at load). */
function todayLocal(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** `YYYY-MM-DD` → days since epoch, via UTC so no DST shift can move a date. */
function dateToDays(day: string): number | null {
  const ms = Date.parse(`${day.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000)
}

/** Days since epoch → `YYYY-MM-DD`. */
function daysToDate(days: number): string {
  return new Date(days * 86_400_000).toISOString().slice(0, 10)
}

/** The Monday–Sunday span containing `today` (ISO 8601 weeks). */
function weekBounds(today: string): [string, string] | null {
  const days = dateToDays(today)
  if (days === null) return null
  // 1970-01-01 was a Thursday, which anchors the weekday arithmetic.
  const fromMonday = (((days + 3) % 7) + 7) % 7
  const monday = days - fromMonday
  return [daysToDate(monday), daysToDate(monday + 6)]
}

/** Resolve an `in_span` value to concrete bounds, against today. */
function resolveSpan(value: unknown, today: string): [string, string] | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as SpanValue
  if (v.moving) {
    const base = dateToDays(today)
    if (base === null) return null
    const from = typeof v.fromDays === 'number' ? v.fromDays : 0
    const to = typeof v.toDays === 'number' ? v.toDays : 0
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    return [daysToDate(base + lo), daysToDate(base + hi)]
  }
  if (typeof v.from !== 'string' || typeof v.to !== 'string') return null
  const from = v.from.slice(0, 10)
  const to = v.to.slice(0, 10)
  return from <= to ? [from, to] : [to, from]
}

/** The `YYYY-MM-DD` calendar-day prefix of an ISO-ish date string. */
function dayPrefix(value: unknown): string {
  return String(value).slice(0, 10)
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : []
}

function equalsMatch(cellValue: unknown, filterValue: unknown, columnType: string): boolean {
  if (isEmpty(cellValue)) return false
  if (columnType === 'number') return Number(cellValue) === Number(filterValue)
  if (columnType === 'date') return dayPrefix(cellValue) === dayPrefix(filterValue)
  if (columnType === 'boolean') return cellValue === filterValue
  return String(cellValue) === String(filterValue)
}

function containsMatch(cellValue: unknown, filterValue: unknown): boolean {
  if (isEmpty(cellValue)) return false
  return String(cellValue).toLowerCase().includes(String(filterValue).toLowerCase())
}

/** Numeric/date ordered comparison. Empty/NaN on either side -> false. */
function compare(
  cellValue: unknown,
  filterValue: unknown,
  columnType: string,
): number | null {
  if (isEmpty(cellValue) || isEmpty(filterValue)) return null
  let a: number
  let b: number
  if (columnType === 'date') {
    a = Date.parse(String(cellValue))
    b = Date.parse(String(filterValue))
  } else {
    a = Number(cellValue)
    b = Number(filterValue)
  }
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Substitute {@link ME} for the viewer's MXID, on member columns only. An
 * unresolvable `@me` (no viewer) becomes `null`, which the positive operators
 * treat as "no match" — the safe direction.
 */
function resolveMe(filterValue: unknown, columnType: string, ctx?: FilterContext): unknown {
  if (columnType !== 'member' && columnType !== 'multimember') return filterValue
  const me = ctx?.me ?? null
  if (filterValue === ME) return me
  if (Array.isArray(filterValue) && filterValue.includes(ME)) {
    return filterValue.map(v => (v === ME ? me : v))
  }
  return filterValue
}

/** Whether a single cell value satisfies one operator. */
export function matchesCondition(
  cellValue: unknown,
  op: FilterOp,
  rawFilterValue: unknown,
  columnType: string,
  ctx?: FilterContext,
): boolean {
  const filterValue = resolveMe(rawFilterValue, columnType, ctx)
  switch (op) {
    case 'is_empty':
      return isEmpty(cellValue)
    case 'is_not_empty':
      return !isEmpty(cellValue)
    case 'is_today':
      if (isEmpty(cellValue)) return false
      return dayPrefix(cellValue) === (ctx?.today ?? todayLocal())
    case 'is_this_week': {
      if (isEmpty(cellValue)) return false
      const bounds = weekBounds(ctx?.today ?? todayLocal())
      if (!bounds) return false
      const day = dayPrefix(cellValue)
      return day >= bounds[0] && day <= bounds[1]
    }
    case 'in_span': {
      if (isEmpty(cellValue)) return false
      const bounds = resolveSpan(filterValue, ctx?.today ?? todayLocal())
      if (!bounds) return false
      // Inclusive at both ends: a span typed as 1st–7th contains the 7th.
      const day = dayPrefix(cellValue)
      return day >= bounds[0] && day <= bounds[1]
    }
    case 'equals':
      return equalsMatch(cellValue, filterValue, columnType)
    case 'not_equals':
      return isEmpty(cellValue) || !equalsMatch(cellValue, filterValue, columnType)
    case 'contains':
      return containsMatch(cellValue, filterValue)
    case 'not_contains':
      return !containsMatch(cellValue, filterValue)
    case 'greater_than': {
      const c = compare(cellValue, filterValue, columnType)
      return c !== null && c > 0
    }
    case 'greater_than_or_equal': {
      const c = compare(cellValue, filterValue, columnType)
      return c !== null && c >= 0
    }
    case 'less_than': {
      const c = compare(cellValue, filterValue, columnType)
      return c !== null && c < 0
    }
    case 'less_than_or_equal': {
      const c = compare(cellValue, filterValue, columnType)
      return c !== null && c <= 0
    }
    case 'is_any_of': {
      if (isEmpty(cellValue) || !Array.isArray(filterValue)) return false
      const cell = String(cellValue)
      return filterValue.some((v) => String(v) === cell)
    }
    case 'has_any_of': {
      if (!Array.isArray(cellValue) || !Array.isArray(filterValue)) return false
      const cell = toStringArray(cellValue)
      return toStringArray(filterValue).some((v) => cell.includes(v))
    }
    case 'has_all_of': {
      if (!Array.isArray(filterValue)) return false
      const cell = toStringArray(cellValue)
      return toStringArray(filterValue).every((v) => cell.includes(v))
    }
    case 'has_none_of': {
      if (!Array.isArray(filterValue)) return false
      const cell = toStringArray(cellValue)
      return !toStringArray(filterValue).some((v) => cell.includes(v))
    }
    default:
      // Unknown operator: don't drop rows.
      return true
  }
}

/**
 * Keep rows where EVERY condition matches (AND). `columnsById` maps columnId ->
 * {@link FilterColumn}. A condition whose column is missing from `columnsById`
 * is ignored (treated as pass). Empty `conditions` returns `rows` unchanged.
 */
export function applyFilters<T extends Record<string, unknown>>(
  rows: T[],
  conditions: FilterCondition[],
  columnsById: Record<string, FilterColumn>,
  ctx?: FilterContext,
): T[] {
  if (conditions.length === 0) return rows
  return rows.filter((row) =>
    conditions.every((c) => {
      const column = columnsById[c.columnId]
      if (!column) return true
      return matchesCondition(row[c.columnId], c.operator, c.value, column.column_type, ctx)
    }),
  )
}
