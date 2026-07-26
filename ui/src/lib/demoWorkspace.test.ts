import { describe, it, expect, vi } from 'vitest'
import { seedDemoWorkspace } from './demoWorkspace'

function makeCws() {
  return {
    createTable: vi.fn().mockResolvedValue('[]'),
    createView: vi.fn().mockResolvedValue('ok'),
    updateCell: vi.fn().mockResolvedValue(undefined),
  }
}

describe('seedDemoWorkspace', () => {
  it('creates the two demo tables and a kanban board', async () => {
    const cws = makeCws()
    await seedDemoWorkspace(cws, '@me:tidework.io')

    expect(cws.createTable).toHaveBeenCalledTimes(2)
    const tables = cws.createTable.mock.calls.map(c => JSON.parse(c[0]))
    expect(tables.map(t => t.id)).toEqual(['tasks', 'contacts'])
    // Template columns come through with schema options intact.
    expect(tables[0].columns.status.options).toContain('In Progress')
    // The assignee column is a member column (issue bc48a6ed).
    expect(tables[0].columns.assignee.column_type).toBe('member')

    expect(cws.createView).toHaveBeenCalledTimes(2)
    const view = JSON.parse(cws.createView.mock.calls[0][0])
    expect(view.view_type).toBe('kanban')
    expect(view.table_id).toBe('tasks')
    expect(view.kanban_config.group_by_column).toBe('status')
    expect(view.kanban_config.column_options).toEqual(['Todo', 'In Progress', 'Done'])
    // The card footer is an explicit view setting, not inferred (bc48a6ed).
    expect(view.kanban_config.assignee_column).toBe('assignee')

    // The second board is the personal one: same table, filtered to the viewer
    // via the `@me` sentinel (issue aaae6f3f).
    const mine = JSON.parse(cws.createView.mock.calls[1][0])
    expect(mine.name).toBe('My Board')
    expect(mine.filters).toEqual([
      { column_id: 'assignee', operator: 'equals', value: '@me' },
    ])
  })

  it('links tasks to contacts in both arities, defined in the table itself', async () => {
    const cws = makeCws()
    await seedDemoWorkspace(cws, '@me:tidework.io')

    // The reference columns are part of the CREATE definition (template
    // format), not patched on afterwards (issue 341282fe).
    const tasksDef = JSON.parse(cws.createTable.mock.calls[0][0])
    const client = tasksDef.columns.client
    expect(client.column_type).toBe('reference')
    expect(client.reference_table).toBe('contacts')
    // Which contact column labels a linked row is stored, not inferred.
    expect(client.reference_display_column).toBe('name')
    const stakeholders = tasksDef.columns.stakeholders
    expect(stakeholders.column_type).toBe('multireference')
    expect(stakeholders.reference_table).toBe('contacts')
    expect(stakeholders.reference_display_column).toBe('name')

    // Every seeded link points at a contacts row that actually exists —
    // single ids and multi-id arrays alike. A demo with dangling references
    // would showcase the broken-link style instead of the feature.
    const writes = cws.updateCell.mock.calls
    const contactIds = new Set(writes.filter(w => w[0] === 'contacts').map(w => w[1]))
    const clients = writes.filter(w => w[0] === 'tasks' && w[2] === 'client').map(w => JSON.parse(w[3]))
    expect(clients.length).toBeGreaterThan(0)
    for (const c of clients) expect(contactIds.has(c)).toBe(true)
    const multi = writes.filter(w => w[0] === 'tasks' && w[2] === 'stakeholders').map(w => JSON.parse(w[3]))
    expect(multi.length).toBeGreaterThan(0)
    for (const arr of multi) {
      expect(Array.isArray(arr)).toBe(true)
      expect(arr.length).toBeGreaterThan(0) // empty arrays are skipped at seed
      for (const id of arr) expect(contactIds.has(id)).toBe(true)
    }
  })

  it('seeds rows into both tables, skipping empty values', async () => {
    const cws = makeCws()
    await seedDemoWorkspace(cws, '@me:tidework.io')

    const writes = cws.updateCell.mock.calls
    const tasksRows = new Set(writes.filter(w => w[0] === 'tasks').map(w => w[1]))
    const contactRows = new Set(writes.filter(w => w[0] === 'contacts').map(w => w[1]))
    expect(tasksRows.size).toBeGreaterThanOrEqual(8)
    expect(contactRows.size).toBeGreaterThanOrEqual(4)

    // Values are JSON-encoded and never empty.
    for (const [, , , valueJson] of writes) {
      const v = JSON.parse(valueJson)
      expect(v).not.toBe('')
      expect(v).not.toBeNull()
    }

    // Every status lands on a real kanban lane.
    const statuses = writes.filter(w => w[0] === 'tasks' && w[2] === 'status').map(w => JSON.parse(w[3]))
    for (const s of statuses) expect(['Todo', 'In Progress', 'Done']).toContain(s)

    // Assignees are the creating user's MXID (member column, issue bc48a6ed).
    const assignees = writes.filter(w => w[0] === 'tasks' && w[2] === 'assignee').map(w => JSON.parse(w[3]))
    expect(assignees.length).toBeGreaterThanOrEqual(3)
    for (const a of assignees) expect(a).toBe('@me:tidework.io')
  })
})
