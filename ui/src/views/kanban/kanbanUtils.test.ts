import { describe, it, expect } from 'vitest'
import { resolveTargetColumn, KanbanColumn } from './kanbanUtils'

const columns: KanbanColumn[] = [
  {
    id: 'Todo',
    title: 'Todo',
    cards: [
      { id: 'row_1', title: 'First task' },
      { id: 'row_2', title: 'Second task' },
    ],
  },
  {
    id: 'In Progress',
    title: 'In Progress',
    cards: [
      { id: 'row_3', title: 'Third task' },
    ],
  },
  {
    id: 'Done',
    title: 'Done',
    cards: [],
  },
]

describe('resolveTargetColumn', () => {
  it('returns the column id when over.id is a direct column id', () => {
    expect(resolveTargetColumn('Todo', columns)).toBe('Todo')
    expect(resolveTargetColumn('In Progress', columns)).toBe('In Progress')
    expect(resolveTargetColumn('Done', columns)).toBe('Done')
  })

  it('returns the owning column id when over.id is a card id', () => {
    // Dropping on row_1 should resolve to the "Todo" column
    expect(resolveTargetColumn('row_1', columns)).toBe('Todo')
    // Dropping on row_2 should also resolve to "Todo"
    expect(resolveTargetColumn('row_2', columns)).toBe('Todo')
    // Dropping on row_3 should resolve to "In Progress"
    expect(resolveTargetColumn('row_3', columns)).toBe('In Progress')
  })

  it('returns null when over.id matches neither a column nor a card', () => {
    expect(resolveTargetColumn('nonexistent', columns)).toBeNull()
    expect(resolveTargetColumn('', columns)).toBeNull()
  })

  it('works with an empty columns array', () => {
    expect(resolveTargetColumn('Todo', [])).toBeNull()
  })

  it('works when all columns are empty', () => {
    const emptyCols: KanbanColumn[] = [
      { id: 'Backlog', title: 'Backlog', cards: [] },
    ]
    expect(resolveTargetColumn('Backlog', emptyCols)).toBe('Backlog')
    expect(resolveTargetColumn('row_99', emptyCols)).toBeNull()
  })

  it('does not confuse a column id that looks like a row id', () => {
    const weirdCols: KanbanColumn[] = [
      { id: 'row_999', title: 'row_999', cards: [] },
    ]
    // 'row_999' is actually a column here – should resolve as column
    expect(resolveTargetColumn('row_999', weirdCols)).toBe('row_999')
  })
})
