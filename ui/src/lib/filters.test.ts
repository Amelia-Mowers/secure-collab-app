import { describe, it, expect } from 'vitest'
import {
  operatorsForType,
  operatorNeedsValue,
  matchesCondition,
  applyFilters,
  ME,
  type FilterCondition,
  type FilterColumn,
  type FilterOp,
} from './filters'

/** Today's local date as YYYY-MM-DD, built the same way the engine does. */
function todayLocal(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

const ops = (columnType: string): FilterOp[] => operatorsForType(columnType).map((o) => o.op)

describe('operatorsForType', () => {
  it('always includes the EMPTY_OPS pair (except boolean, which renames them)', () => {
    for (const t of ['text', 'number', 'date', 'select', 'multiselect', 'json', 'reference']) {
      expect(ops(t)).toContain('is_empty')
      expect(ops(t)).toContain('is_not_empty')
    }
  })

  it('offers text-like ops for text and document', () => {
    for (const t of ['text', 'document']) {
      expect(ops(t)).toEqual([
        'contains',
        'not_contains',
        'equals',
        'not_equals',
        'is_empty',
        'is_not_empty',
      ])
    }
  })

  // A reference cell holds a row id, so substring matching on it is
  // meaningless — references pick from rows, like a select (issue c14e01a0).
  it('offers identity ops for reference, set ops for multireference', () => {
    expect(ops('reference')).toEqual(ops('select'))
    expect(ops('multireference')).toEqual(ops('multiselect'))
    expect(ops('reference')).not.toContain('contains')
  })

  it('offers ordered relative-date ops for date', () => {
    expect(ops('date')).toEqual([
      'equals',
      'not_equals',
      'less_than',
      'less_than_or_equal',
      'greater_than',
      'greater_than_or_equal',
      'is_today',
      'is_this_week',
      'in_span',
      'is_empty',
      'is_not_empty',
    ])
    const byOp = new Map(operatorsForType('date').map((o) => [o.op, o.label]))
    expect(byOp.get('less_than')).toBe('is before')
    expect(byOp.get('greater_than')).toBe('is after')
    expect(byOp.get('is_today')).toBe('is today')
    expect(byOp.get('is_this_week')).toBe('is this week')
    expect(byOp.get('in_span')).toBe('is within')
  })

  it('offers comparison ops for number and set ops for multiselect', () => {
    expect(ops('number')).toEqual([
      'equals',
      'not_equals',
      'greater_than',
      'greater_than_or_equal',
      'less_than',
      'less_than_or_equal',
      'is_empty',
      'is_not_empty',
    ])
    expect(ops('multiselect')).toEqual([
      'has_any_of',
      'has_all_of',
      'has_none_of',
      'is_empty',
      'is_not_empty',
    ])
    expect(ops('select')).toContain('is_any_of')
  })

  it('falls back to json ops for an unknown column type', () => {
    expect(ops('mystery')).toEqual(operatorsForType('json').map((o) => o.op))
  })
})

describe('operatorNeedsValue', () => {
  it('is false for is_empty / is_not_empty / is_today and true otherwise', () => {
    expect(operatorNeedsValue('is_empty')).toBe(false)
    expect(operatorNeedsValue('is_not_empty')).toBe(false)
    expect(operatorNeedsValue('is_today')).toBe(false)
    expect(operatorNeedsValue('equals')).toBe(true)
    expect(operatorNeedsValue('contains')).toBe(true)
  })
})

describe('matchesCondition — numbers', () => {
  it('handles > >= < <=', () => {
    expect(matchesCondition(5, 'greater_than', 3, 'number')).toBe(true)
    expect(matchesCondition(3, 'greater_than', 3, 'number')).toBe(false)
    expect(matchesCondition(3, 'greater_than_or_equal', 3, 'number')).toBe(true)
    expect(matchesCondition(2, 'less_than', 3, 'number')).toBe(true)
    expect(matchesCondition(3, 'less_than_or_equal', 3, 'number')).toBe(true)
    expect(matchesCondition(4, 'less_than_or_equal', 3, 'number')).toBe(false)
  })

  it('comparison against an empty cell or value is false', () => {
    expect(matchesCondition(null, 'greater_than', 3, 'number')).toBe(false)
    expect(matchesCondition(5, 'greater_than', null, 'number')).toBe(false)
  })

  it('numeric equals/not_equals', () => {
    expect(matchesCondition(5, 'equals', 5, 'number')).toBe(true)
    expect(matchesCondition(5, 'not_equals', 5, 'number')).toBe(false)
    expect(matchesCondition(5, 'not_equals', 6, 'number')).toBe(true)
  })
})

describe('matchesCondition — text', () => {
  it('contains is case-insensitive; empty cell is false', () => {
    expect(matchesCondition('Hello World', 'contains', 'hello', 'text')).toBe(true)
    expect(matchesCondition('Hello', 'contains', 'xyz', 'text')).toBe(false)
    expect(matchesCondition('', 'contains', 'a', 'text')).toBe(false)
  })

  it('not_contains is the inverse and an empty cell passes', () => {
    expect(matchesCondition('Hello', 'not_contains', 'xyz', 'text')).toBe(true)
    expect(matchesCondition('Hello', 'not_contains', 'ell', 'text')).toBe(false)
    expect(matchesCondition(null, 'not_contains', 'a', 'text')).toBe(true)
  })

  it('not_equals on an empty cell counts as "is not X"', () => {
    expect(matchesCondition(null, 'not_equals', 'x', 'text')).toBe(true)
    expect(matchesCondition('x', 'not_equals', 'x', 'text')).toBe(false)
    expect(matchesCondition('y', 'equals', 'x', 'text')).toBe(false)
    expect(matchesCondition('x', 'equals', 'x', 'text')).toBe(true)
  })
})

describe('matchesCondition — select / multiselect', () => {
  it('select is_any_of', () => {
    expect(matchesCondition('b', 'is_any_of', ['a', 'b', 'c'], 'select')).toBe(true)
    expect(matchesCondition('z', 'is_any_of', ['a', 'b', 'c'], 'select')).toBe(false)
    expect(matchesCondition(null, 'is_any_of', ['a'], 'select')).toBe(false)
  })

  it('multiselect has_any_of / has_all_of / has_none_of', () => {
    expect(matchesCondition(['a', 'b'], 'has_any_of', ['b', 'x'], 'multiselect')).toBe(true)
    expect(matchesCondition(['a', 'b'], 'has_any_of', ['x', 'y'], 'multiselect')).toBe(false)
    expect(matchesCondition(['a', 'b', 'c'], 'has_all_of', ['a', 'b'], 'multiselect')).toBe(true)
    expect(matchesCondition(['a'], 'has_all_of', ['a', 'b'], 'multiselect')).toBe(false)
    expect(matchesCondition(['a', 'b'], 'has_none_of', ['x', 'y'], 'multiselect')).toBe(true)
    expect(matchesCondition(['a', 'b'], 'has_none_of', ['b'], 'multiselect')).toBe(false)
  })

  it('empty multiselect cell: has_none_of true, has_any_of/has_all_of false', () => {
    expect(matchesCondition([], 'has_none_of', ['a'], 'multiselect')).toBe(true)
    expect(matchesCondition([], 'has_any_of', ['a'], 'multiselect')).toBe(false)
    expect(matchesCondition([], 'has_all_of', ['a'], 'multiselect')).toBe(false)
  })
})

describe('matchesCondition — dates', () => {
  it('is before / is after compare calendar instants', () => {
    expect(matchesCondition('2026-01-01', 'less_than', '2026-06-01', 'date')).toBe(true)
    expect(matchesCondition('2026-12-01', 'less_than', '2026-06-01', 'date')).toBe(false)
    expect(matchesCondition('2026-12-01', 'greater_than', '2026-06-01', 'date')).toBe(true)
    expect(matchesCondition('2026-06-01', 'less_than_or_equal', '2026-06-01', 'date')).toBe(true)
  })

  it('date equals compares the calendar day', () => {
    expect(matchesCondition('2026-06-01', 'equals', '2026-06-01', 'date')).toBe(true)
    expect(matchesCondition('2026-06-01T09:00:00Z', 'equals', '2026-06-01', 'date')).toBe(true)
    expect(matchesCondition('2026-06-02', 'equals', '2026-06-01', 'date')).toBe(false)
  })

  it('is_today matches today and nothing else', () => {
    const today = todayLocal()
    expect(matchesCondition(today, 'is_today', undefined, 'date')).toBe(true)
    expect(matchesCondition('1999-01-01', 'is_today', undefined, 'date')).toBe(false)
    expect(matchesCondition(null, 'is_today', undefined, 'date')).toBe(false)
  })
})

describe('matchesCondition — empties and unknown op', () => {
  it('is_empty / is_not_empty across null, "", [] and a value', () => {
    for (const empty of [null, undefined, '', []]) {
      expect(matchesCondition(empty, 'is_empty', undefined, 'text')).toBe(true)
      expect(matchesCondition(empty, 'is_not_empty', undefined, 'text')).toBe(false)
    }
    expect(matchesCondition('x', 'is_empty', undefined, 'text')).toBe(false)
    expect(matchesCondition('x', 'is_not_empty', undefined, 'text')).toBe(true)
    expect(matchesCondition(['a'], 'is_not_empty', undefined, 'multiselect')).toBe(true)
  })

  it('an unrecognised operator never drops a row', () => {
    expect(matchesCondition('anything', 'who_knows' as FilterOp, 'x', 'text')).toBe(true)
  })
})

describe('applyFilters', () => {
  const columnsById: Record<string, FilterColumn> = {
    title: { id: 'title', column_type: 'text' },
    count: { id: 'count', column_type: 'number' },
    tags: { id: 'tags', column_type: 'multiselect' },
  }
  const rows = [
    { title: 'Alpha', count: 1, tags: ['x'] },
    { title: 'Beta', count: 5, tags: ['x', 'y'] },
    { title: 'Gamma', count: 9, tags: [] },
  ]

  it('returns the rows unchanged when there are no conditions', () => {
    expect(applyFilters(rows, [], columnsById)).toBe(rows)
  })

  it('ANDs conditions together', () => {
    const conditions: FilterCondition[] = [
      { columnId: 'count', operator: 'greater_than', value: 2 },
      { columnId: 'tags', operator: 'has_any_of', value: ['y'] },
    ]
    const out = applyFilters(rows, conditions, columnsById)
    expect(out.map((r) => r.title)).toEqual(['Beta'])
  })

  it('ignores a condition whose column is missing from columnsById', () => {
    const conditions: FilterCondition[] = [
      { columnId: 'nope', operator: 'equals', value: 'whatever' },
      { columnId: 'title', operator: 'contains', value: 'a' },
    ]
    const out = applyFilters(rows, conditions, columnsById)
    expect(out.map((r) => r.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
  })
})

describe('the @me sentinel', () => {
  const ALICE = '@alice:example.org'
  const BOB = '@bob:example.org'

  it('resolves to the viewer on member columns', () => {
    expect(matchesCondition(ALICE, 'equals', ME, 'member', { me: ALICE })).toBe(true)
    expect(matchesCondition(ALICE, 'equals', ME, 'member', { me: BOB })).toBe(false)
    // Inside a list, next to literal MXIDs.
    expect(matchesCondition(ALICE, 'is_any_of', [BOB, ME], 'member', { me: ALICE })).toBe(true)
    // Multi-member cells.
    expect(matchesCondition([BOB, ALICE], 'has_any_of', [ME], 'multimember', { me: ALICE })).toBe(
      true,
    )
    expect(matchesCondition([BOB], 'has_any_of', [ME], 'multimember', { me: ALICE })).toBe(false)
  })

  it('is a literal string off member columns', () => {
    expect(matchesCondition(ME, 'equals', ME, 'text', { me: ALICE })).toBe(true)
    expect(matchesCondition(ALICE, 'equals', ME, 'text', { me: ALICE })).toBe(false)
  })

  it('matches nobody when there is no viewer', () => {
    expect(matchesCondition(ALICE, 'equals', ME, 'member')).toBe(false)
    expect(matchesCondition(ALICE, 'equals', ME, 'member', { me: null })).toBe(false)
    expect(matchesCondition([ALICE], 'has_any_of', [ME], 'multimember', {})).toBe(false)
  })

  it('selects a personal board through applyFilters', () => {
    const columnsById: Record<string, FilterColumn> = {
      assignee: { id: 'assignee', column_type: 'member' },
    }
    const rows = [
      { title: 'mine', assignee: ALICE },
      { title: 'theirs', assignee: BOB },
      { title: 'nobody', assignee: null },
    ]
    const mine: FilterCondition[] = [{ columnId: 'assignee', operator: 'equals', value: ME }]
    expect(applyFilters(rows, mine, columnsById, { me: ALICE }).map((r) => r.title)).toEqual([
      'mine',
    ])
    // The SAME saved view, a different viewer.
    expect(applyFilters(rows, mine, columnsById, { me: BOB }).map((r) => r.title)).toEqual([
      'theirs',
    ])
  })
})

describe('the injected today', () => {
  it('overrides the local calendar day', () => {
    expect(matchesCondition('2020-01-01', 'is_today', undefined, 'date', { today: '2020-01-01' }))
      .toBe(true)
    expect(matchesCondition(todayLocal(), 'is_today', undefined, 'date', { today: '2020-01-01' }))
      .toBe(false)
  })
})

describe('date spans (issue 5d2efeac)', () => {
  // A Tuesday, so the ISO week runs Mon 20th – Sun 26th.
  const TODAY = '2026-07-21'
  const on = (cell: string, op: FilterOp, value?: unknown, today = TODAY) =>
    matchesCondition(cell, op, value, 'date', { today })

  it('is_this_week covers Monday through Sunday', () => {
    for (const day of ['2026-07-20', '2026-07-21', '2026-07-26']) {
      expect(on(day, 'is_this_week')).toBe(true)
    }
    for (const day of ['2026-07-19', '2026-07-27']) {
      expect(on(day, 'is_this_week')).toBe(false)
    }
    expect(matchesCondition(null, 'is_this_week', undefined, 'date', { today: TODAY })).toBe(false)
  })

  it('a fixed span includes both ends, in either order', () => {
    const span = { moving: false, from: '2026-03-01', to: '2026-03-31' }
    expect(on('2026-03-01', 'in_span', span)).toBe(true)
    expect(on('2026-03-31', 'in_span', span)).toBe(true)
    expect(on('2026-02-28', 'in_span', span)).toBe(false)
    expect(on('2026-04-01', 'in_span', span)).toBe(false)
    expect(on('2026-03-15', 'in_span', { from: '2026-03-31', to: '2026-03-01' })).toBe(true)
  })

  it('a moving span rolls with today', () => {
    const lastWeek = { moving: true, fromDays: -7, toDays: 0 }
    expect(on('2026-07-21', 'in_span', lastWeek)).toBe(true)
    expect(on('2026-07-14', 'in_span', lastWeek)).toBe(true)
    expect(on('2026-07-13', 'in_span', lastWeek)).toBe(false)
    // Tomorrow is outside a window ending today...
    expect(on('2026-07-22', 'in_span', lastWeek)).toBe(false)
    // ...and the SAME filter a day later includes it. That is the point of it.
    expect(on('2026-07-22', 'in_span', lastWeek, '2026-07-22')).toBe(true)
  })

  it('span arithmetic survives month, leap-year and new-year boundaries', () => {
    expect(on('2026-02-26', 'in_span', { moving: true, fromDays: -3, toDays: 0 }, '2026-03-01'))
      .toBe(true)
    expect(on('2024-02-29', 'in_span', { moving: true, fromDays: -1, toDays: 0 }, '2024-03-01'))
      .toBe(true)
    expect(on('2025-12-31', 'in_span', { moving: true, fromDays: -2, toDays: 0 }, '2026-01-02'))
      .toBe(true)
  })

  it('a malformed span matches nothing', () => {
    for (const bad of [{}, '2026-01-01', { from: '2026-01-01' }, null]) {
      expect(on('2026-01-01', 'in_span', bad)).toBe(false)
    }
  })

  it('the span operators need no value input except in_span', () => {
    expect(operatorNeedsValue('is_this_week')).toBe(false)
    expect(operatorNeedsValue('in_span')).toBe(true)
  })
})
