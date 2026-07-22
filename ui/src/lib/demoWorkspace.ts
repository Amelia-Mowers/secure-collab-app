/**
 * Seed content for the "Create demo workspace" button (issue c0ace30a): a
 * real, synced workspace (unlike the old local-only demo) pre-populated so
 * every surface has something to show — a project tracker with a kanban
 * board, and a contacts table with a document cell.
 *
 * Writes go through the normal ConnectedWorkspace APIs, so the result is an
 * ordinary workspace: encrypted, collaborative, and safe to delete.
 */

import { TABLE_TEMPLATES, buildTableDefinition } from '../tableTemplates'

export const DEMO_WORKSPACE_NAME = 'Demo Workspace'

type Row = Record<string, unknown>

/** `assignee` is a member column (issue bc48a6ed): SELF is replaced by the
 *  creating user's MXID at seed time — the only member of a fresh demo room. */
const SELF = '@@self'

const TASKS: Row[] = [
  { title: 'Sketch landing page hero', status: 'Done', assignee: SELF, due_date: '2026-07-10', priority: 'High' },
  { title: 'Wire up sign-up flow', status: 'Done', assignee: '', due_date: '2026-07-14', priority: 'High' },
  { title: 'Draft pricing copy', status: 'In Progress', assignee: SELF, due_date: '2026-07-24', priority: 'Medium' },
  { title: 'Instrument onboarding funnel', status: 'In Progress', assignee: '', due_date: '2026-07-28', priority: 'Medium' },
  { title: 'Fix mobile nav overlap', status: 'In Progress', assignee: SELF, due_date: '2026-07-22', priority: 'High' },
  { title: 'Choose launch date', status: 'Todo', assignee: SELF, due_date: '2026-08-04', priority: 'High' },
  { title: 'Write changelog post', status: 'Todo', assignee: '', due_date: '2026-08-06', priority: 'Low' },
  { title: 'QA pass on dark mode', status: 'Todo', assignee: '', due_date: '', priority: 'Low' },
]

const CONTACTS: Row[] = [
  { name: 'Dana Whitfield', email: 'dana@acme.test', company: 'Acme Analytics', status: 'Active', notes: '# Notes\nIntro call went well — wants the collaborative tables demo for her team.' },
  { name: 'Marcus Lee', email: 'marcus@brightloop.test', company: 'Brightloop', status: 'Lead', notes: 'Met at the privacy-tech meetup. Cares about **end-to-end encryption** specifically.' },
  { name: 'Priya Nair', email: 'priya@fernworks.test', company: 'Fernworks', status: 'Lead', notes: 'Asked for pricing; follow up next week.' },
  { name: 'Jo Salter', email: 'jo@tidal.test', company: 'Tidal Studio', status: 'Closed', notes: 'Went with a spreadsheet for now — check back next quarter.' },
]

/** Rows are seeded with deterministic ids so re-running is idempotent-ish and
 *  tests can assert on them. */
const rowId = (table: string, i: number) => `demo_${table}_${i + 1}`

/**
 * Populate a freshly created, empty workspace. `cws` is a ConnectedWorkspace
 * (the WASM bridge object). Cell writes go through the debounced batch queue,
 * so this resolves quickly and the sends complete in the background.
 */
export async function seedDemoWorkspace(
  cws: {
    createTable(json: string): Promise<string>
    createView(json: string): Promise<string>
    updateCell(tableId: string, rowId: string, colId: string, valueJson: string): Promise<void>
  },
  /** The creating user's MXID — the demo's member-column assignee. */
  selfUserId?: string,
): Promise<void> {
  const project = TABLE_TEMPLATES.find(t => t.id === 'project')!
  const contacts = TABLE_TEMPLATES.find(t => t.id === 'contacts')!

  await cws.createTable(JSON.stringify(buildTableDefinition('tasks', 'Projects', project)))
  await cws.createTable(JSON.stringify(buildTableDefinition('contacts', 'Contacts', contacts)))

  await cws.createView(
    JSON.stringify({
      id: 'tasks-board',
      name: 'Board',
      table_id: 'tasks',
      view_type: 'kanban',
      sort: [],
      filters: [],
      kanban_config: {
        group_by_column: 'status',
        title_column: 'title',
        display_columns: [],
        column_options: project.columns.find(c => c.id === 'status')?.options ?? [],
      },
    }),
  )

  const writeRows = async (tableId: string, rows: Row[]) => {
    for (const [i, row] of rows.entries()) {
      for (const [col, value] of Object.entries(row)) {
        if (value === '' || value == null) continue
        const resolved = value === SELF ? selfUserId : value
        if (resolved === '' || resolved == null) continue
        await cws.updateCell(tableId, rowId(tableId, i), col, JSON.stringify(resolved))
      }
    }
  }
  await writeRows('tasks', TASKS)
  await writeRows('contacts', CONTACTS)
}
