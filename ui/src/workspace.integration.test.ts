/**
 * Integration tests for the WasmWorkspace using the real compiled WASM binary.
 *
 * These tests import `initSync` from the generated wasm-bindgen JS bindings and
 * load the binary synchronously from the filesystem (avoiding the fetch/CORS
 * issues that arise in jsdom).  After that, `WasmWorkspace` behaves exactly as
 * it would in a real browser session.
 *
 * Run with: npm test -- workspace.integration
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The path alias resolver in vitest.config.ts maps '@/' → 'src/', so we can
// use the normal import path.  vite-plugin-wasm handles the .wasm transform.
import { initSync, WasmWorkspace } from '@/wasm/generated/app_core.js'
import { buildTableDefinition, TABLE_TEMPLATES } from '@/tableTemplates'

// ──────────────────────────────────────────────────────────────────────────────
// One-time WASM initialisation
// ──────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

beforeAll(() => {
  const wasmBytes = readFileSync(resolve(__dirname, './wasm/generated/app_core_bg.wasm'))
  initSync({ module: wasmBytes })
})

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function freshWorkspace(id = 'test'): InstanceType<typeof WasmWorkspace> {
  return new WasmWorkspace(id)
}

const TASKS_DEF = JSON.stringify({
  id: 'tasks',
  name: 'Tasks',
  columns: {
    title:    { id: 'title',    name: 'Title',    column_type: 'text',    required: true  },
    status:   { id: 'status',   name: 'Status',   column_type: 'select',  required: false,
                options: ['Todo', 'In Progress', 'Done'] },
    assignee: { id: 'assignee', name: 'Assignee', column_type: 'text',    required: false },
    priority: { id: 'priority', name: 'Priority', column_type: 'number',  required: false },
    done:     { id: 'done',     name: 'Done',     column_type: 'boolean', required: false },
    notes:    { id: 'notes',    name: 'Notes',    column_type: 'document',required: false },
  },
})

// ──────────────────────────────────────────────────────────────────────────────
// User story: Table lifecycle
// ──────────────────────────────────────────────────────────────────────────────

describe('User story: table lifecycle', () => {
  it('a new workspace starts with no tables', () => {
    const ws = freshWorkspace()
    expect(JSON.parse(ws.listTables())).toEqual([])
  })

  it('createTable adds the table to listTables', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    expect(JSON.parse(ws.listTables())).toContain('tasks')
  })

  it('schema can be retrieved after table creation', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    const schema = JSON.parse(ws.getTableSchema('tasks'))
    expect(schema.name).toBe('Tasks')
    expect(Object.keys(schema.columns)).toContain('title')
    expect(Object.keys(schema.columns)).toContain('status')
  })

  it('multiple tables can coexist in one workspace', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.createTable(JSON.stringify({ id: 'projects', name: 'Projects', columns: {} }))
    const tables = JSON.parse(ws.listTables())
    expect(tables).toContain('tasks')
    expect(tables).toContain('projects')
    expect(tables).toHaveLength(2)
  })

  it('rejects creating a table whose id already exists (no silent merge)', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    expect(() =>
      ws.createTable(JSON.stringify({ id: 'tasks', name: 'Tasks', columns: {} })),
    ).toThrow()
  })

  it('creates every column of a template definition', () => {
    const ws = freshWorkspace()
    const project = TABLE_TEMPLATES.find(t => t.id === 'project')!
    ws.createTable(JSON.stringify(buildTableDefinition('proj', 'Project tracker', project)))
    const schema = JSON.parse(ws.getTableSchema('proj'))
    expect(Object.keys(schema.columns).sort()).toEqual(
      ['assignee', 'due_date', 'priority', 'status', 'title'].sort(),
    )
    expect(schema.columns.status.column_type).toBe('select')
    expect(schema.columns.status.options).toContain('In Progress')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// User story: Cell CRUD
// ──────────────────────────────────────────────────────────────────────────────

describe('User story: cell CRUD', () => {
  it('updateCell and getTableRows round-trip a text value', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.updateCell('tasks', 'row-1', 'title', '"Design the API"')
    const rows = JSON.parse(ws.getTableRows('tasks'))
    const row = rows.find((r: any) => r._row_id === 'row-1')
    expect(row.title).toBe('Design the API')
  })

  it('updateCell handles numeric values', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.updateCell('tasks', 'row-1', 'priority', '3')
    const rows = JSON.parse(ws.getTableRows('tasks'))
    const row = rows.find((r: any) => r._row_id === 'row-1')
    expect(row.priority).toBe(3)
  })

  it('updateCell handles boolean values', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.updateCell('tasks', 'row-1', 'done', 'true')
    const rows = JSON.parse(ws.getTableRows('tasks'))
    const row = rows.find((r: any) => r._row_id === 'row-1')
    expect(row.done).toBe(true)
  })

  it('last write wins on repeated updates to the same cell', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.updateCell('tasks', 'row-1', 'status', '"Todo"')
    ws.updateCell('tasks', 'row-1', 'status', '"In Progress"')
    ws.updateCell('tasks', 'row-1', 'status', '"Done"')
    const rows = JSON.parse(ws.getTableRows('tasks'))
    expect(rows[0].status).toBe('Done')
  })

  it('deleteRow removes the row and leaves others intact', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.updateCell('tasks', 'row-1', 'title', '"Task A"')
    ws.updateCell('tasks', 'row-2', 'title', '"Task B"')
    ws.updateCell('tasks', 'row-3', 'title', '"Task C"')
    ws.deleteRow('tasks', 'row-2')
    const rows = JSON.parse(ws.getTableRows('tasks'))
    const ids = rows.map((r: any) => r._row_id)
    expect(ids).toContain('row-1')
    expect(ids).not.toContain('row-2')
    expect(ids).toContain('row-3')
  })

  it('sparse rows: getTableRows only includes cells that were written', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.updateCell('tasks', 'row-1', 'title', '"Only title set"')
    const rows = JSON.parse(ws.getTableRows('tasks'))
    const row = rows.find((r: any) => r._row_id === 'row-1')
    expect(row.title).toBe('Only title set')
    expect(row.status).toBeUndefined()
    expect(row.assignee).toBeUndefined()
  })

  it('updateCell throws on a nonexistent table', () => {
    const ws = freshWorkspace()
    expect(() => ws.updateCell('ghost', 'r1', 'col', '"val"')).toThrow()
  })

  it('deleteRow throws on a nonexistent table', () => {
    const ws = freshWorkspace()
    expect(() => ws.deleteRow('ghost', 'r1')).toThrow()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// User story: Realistic data entry (from UX_AND_FEATURES rapid creation flow)
// ──────────────────────────────────────────────────────────────────────────────

describe('User story: rapid entry creation', () => {
  it('creates 10 tasks in sequence and all are retrievable', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)

    for (let i = 1; i <= 10; i++) {
      ws.updateCell('tasks', `task-${i}`, 'title',    `"Task ${i}"`)
      ws.updateCell('tasks', `task-${i}`, 'status',   '"Todo"')
      ws.updateCell('tasks', `task-${i}`, 'assignee', `"User ${(i % 3) + 1}"`)
      ws.updateCell('tasks', `task-${i}`, 'priority', String(i))
    }

    const rows = JSON.parse(ws.getTableRows('tasks'))
    expect(rows).toHaveLength(10)
    expect(rows.find((r: any) => r._row_id === 'task-5').title).toBe('Task 5')
    expect(rows.find((r: any) => r._row_id === 'task-10').priority).toBe(10)
  })

  it('handles unicode content in document cells', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    const content = '# 重要なタスク\n**優先度**: 高\n*担当者*: 田中さん\n`code example`'
    ws.updateCell('tasks', 'task-jp', 'notes', JSON.stringify(content))
    const rows = JSON.parse(ws.getTableRows('tasks'))
    expect(rows[0].notes).toBe(content)
  })

  it('handles an entry with every column type populated', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.updateCell('tasks', 'full-row', 'title',    '"Complete entry"')
    ws.updateCell('tasks', 'full-row', 'status',   '"In Progress"')
    ws.updateCell('tasks', 'full-row', 'assignee', '"Alice"')
    ws.updateCell('tasks', 'full-row', 'priority', '2')
    ws.updateCell('tasks', 'full-row', 'done',     'false')
    ws.updateCell('tasks', 'full-row', 'notes',    '"# Notes\\n**Details** here"')

    const rows = JSON.parse(ws.getTableRows('tasks'))
    const row = rows.find((r: any) => r._row_id === 'full-row')
    expect(row.title).toBe('Complete entry')
    expect(row.status).toBe('In Progress')
    expect(row.assignee).toBe('Alice')
    expect(row.priority).toBe(2)
    expect(row.done).toBe(false)
    expect(row.notes).toBe('# Notes\n**Details** here')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// User story: Views
// ──────────────────────────────────────────────────────────────────────────────

describe('User story: view management', () => {
  const kanbanCfg = (tableId: string, id: string, name: string) => JSON.stringify({
    id,
    name,
    table_id: tableId,
    view_type: 'kanban',
    sort: [],
    filters: [],
    kanban_config: {
      group_by_column: 'status',
      title_column: 'title',
      display_columns: [],
      column_options: ['Todo', 'In Progress', 'Done'],
    },
  })

  it('createView persists the view and getView retrieves it', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.createView(kanbanCfg('tasks', 'board-1', 'Sprint Board'))
    const view = JSON.parse(ws.getView('board-1'))
    expect(view.name).toBe('Sprint Board')
    expect(view.view_type).toBe('kanban')
    expect(view.table_id).toBe('tasks')
  })

  it('kanban_config.column_options is persisted correctly', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.createView(kanbanCfg('tasks', 'board-2', 'My Board'))
    const view = JSON.parse(ws.getView('board-2'))
    expect(view.kanban_config.column_options).toEqual(['Todo', 'In Progress', 'Done'])
  })

  it('listViewsForTable returns only views for the requested table', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.createTable(JSON.stringify({ id: 'projects', name: 'Projects', columns: {} }))
    ws.createView(kanbanCfg('tasks',    'tasks-view',    'Task Board'))
    ws.createView(kanbanCfg('projects', 'projects-view', 'Project Board'))
    const taskViews    = JSON.parse(ws.listViewsForTable('tasks'))
    const projectViews = JSON.parse(ws.listViewsForTable('projects'))
    expect(taskViews).toContain('tasks-view')
    expect(taskViews).not.toContain('projects-view')
    expect(projectViews).toContain('projects-view')
    expect(projectViews).not.toContain('tasks-view')
  })

  it('multiple views can be created for the same table', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.createView(kanbanCfg('tasks', 'v1', 'Board A'))
    ws.createView(kanbanCfg('tasks', 'v2', 'Board B'))
    ws.createView(kanbanCfg('tasks', 'v3', 'Board C'))
    const views = JSON.parse(ws.listViewsForTable('tasks'))
    expect(views).toHaveLength(3)
  })

  it('createView throws when the target table does not exist', () => {
    const ws = freshWorkspace()
    expect(() => ws.createView(kanbanCfg('ghost', 'v1', 'Broken'))).toThrow()
  })

  it('getView throws for an unknown view ID', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    expect(() => ws.getView('no-such-view')).toThrow()
  })

  it('listViewsForTable returns [] for a table with no views', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    const views = JSON.parse(ws.listViewsForTable('tasks'))
    expect(views).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// User story: Kanban move simulation (the bug that was fixed)
// ──────────────────────────────────────────────────────────────────────────────

describe('User story: moving a card between kanban columns', () => {
  it('updating the group_by_column cell moves the card to the new column', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.updateCell('tasks', 'task-1', 'title',  '"Fix login bug"')
    ws.updateCell('tasks', 'task-1', 'status', '"Todo"')

    // Simulate the resolved drag: update status to "In Progress"
    ws.updateCell('tasks', 'task-1', 'status', '"In Progress"')

    const rows = JSON.parse(ws.getTableRows('tasks'))
    expect(rows[0].status).toBe('In Progress')
  })

  it('moving a card does not affect its title or other fields', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.updateCell('tasks', 'task-1', 'title',    '"Fix login bug"')
    ws.updateCell('tasks', 'task-1', 'status',   '"Todo"')
    ws.updateCell('tasks', 'task-1', 'assignee', '"Alice"')
    ws.updateCell('tasks', 'task-1', 'priority', '1')

    ws.updateCell('tasks', 'task-1', 'status', '"Done"')

    const rows = JSON.parse(ws.getTableRows('tasks'))
    const row = rows.find((r: any) => r._row_id === 'task-1')
    expect(row.title).toBe('Fix login bug')
    expect(row.assignee).toBe('Alice')
    expect(row.priority).toBe(1)
    expect(row.status).toBe('Done')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Edge cases
// ──────────────────────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('empty string cell value is stored and retrieved correctly', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.updateCell('tasks', 'r1', 'title', '""')
    const rows = JSON.parse(ws.getTableRows('tasks'))
    expect(rows[0].title).toBe('')
  })

  it('null JSON value is handled without throwing', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    ws.updateCell('tasks', 'r1', 'title', 'null')
    const rows = JSON.parse(ws.getTableRows('tasks'))
    expect(rows[0].title).toBeNull()
  })

  it('very long string (10 000 chars) round-trips correctly', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    const long = 'x'.repeat(10_000)
    ws.updateCell('tasks', 'r1', 'notes', JSON.stringify(long))
    const rows = JSON.parse(ws.getTableRows('tasks'))
    expect(rows[0].notes).toBe(long)
  })

  it('table IDs with hyphens and underscores are valid', () => {
    const ws = freshWorkspace()
    ws.createTable(JSON.stringify({ id: 'my-table_v2', name: 'My Table v2', columns: {} }))
    expect(JSON.parse(ws.listTables())).toContain('my-table_v2')
  })

  it('deleting a row that does not exist does not throw', () => {
    const ws = freshWorkspace()
    ws.createTable(TASKS_DEF)
    // Should silently succeed (row simply wasn't there)
    expect(() => ws.deleteRow('tasks', 'nonexistent-row')).not.toThrow()
  })
})
