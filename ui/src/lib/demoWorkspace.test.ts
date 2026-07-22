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
    await seedDemoWorkspace(cws)

    expect(cws.createTable).toHaveBeenCalledTimes(2)
    const tables = cws.createTable.mock.calls.map(c => JSON.parse(c[0]))
    expect(tables.map(t => t.id)).toEqual(['tasks', 'contacts'])
    // Template columns come through with schema options intact.
    expect(tables[0].columns.status.options).toContain('In Progress')

    expect(cws.createView).toHaveBeenCalledTimes(1)
    const view = JSON.parse(cws.createView.mock.calls[0][0])
    expect(view.view_type).toBe('kanban')
    expect(view.table_id).toBe('tasks')
    expect(view.kanban_config.group_by_column).toBe('status')
    expect(view.kanban_config.column_options).toEqual(['Todo', 'In Progress', 'Done'])
  })

  it('seeds rows into both tables, skipping empty values', async () => {
    const cws = makeCws()
    await seedDemoWorkspace(cws)

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
  })
})
