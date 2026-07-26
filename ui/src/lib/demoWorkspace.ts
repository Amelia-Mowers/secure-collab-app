/**
 * Seed content for the "Create demo workspace" button (issue c0ace30a): a
 * real, synced workspace (unlike the old local-only demo) pre-populated so
 * every surface has something to show — a project tracker with a kanban
 * board, a contacts table with a document cell, tasks linked to the contact
 * they belong to (a reference column), and a personal board filtered to `@me`.
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

/** `client` holds a CONTACTS row id (reference, labelled by the contact's
 *  `name`); `stakeholders` holds several (multireference) — the demo shows both
 *  arities of cross-table links on real data (issue 341282fe). */
const TASKS: Row[] = [
  { title: 'Sketch landing page hero', status: 'Done', assignee: SELF, due_date: '2026-07-10', priority: 'High', client: 'demo_contacts_1', stakeholders: ['demo_contacts_1', 'demo_contacts_2'] },
  { title: 'Wire up sign-up flow', status: 'Done', assignee: '', due_date: '2026-07-14', priority: 'High', client: 'demo_contacts_1', stakeholders: [] },
  { title: 'Draft pricing copy', status: 'In Progress', assignee: SELF, due_date: '2026-07-24', priority: 'Medium', client: 'demo_contacts_3', stakeholders: ['demo_contacts_3'] },
  { title: 'Instrument onboarding funnel', status: 'In Progress', assignee: '', due_date: '2026-07-28', priority: 'Medium', client: 'demo_contacts_2', stakeholders: ['demo_contacts_1', 'demo_contacts_4'] },
  { title: 'Fix mobile nav overlap', status: 'In Progress', assignee: SELF, due_date: '2026-07-22', priority: 'High', client: '', stakeholders: [] },
  { title: 'Choose launch date', status: 'Todo', assignee: SELF, due_date: '2026-08-04', priority: 'High', client: 'demo_contacts_2', stakeholders: ['demo_contacts_2', 'demo_contacts_3'] },
  { title: 'Write changelog post', status: 'Todo', assignee: '', due_date: '2026-08-06', priority: 'Low', client: '', stakeholders: [] },
  { title: 'QA pass on dark mode', status: 'Todo', assignee: '', due_date: '', priority: 'Low', client: 'demo_contacts_4', stakeholders: ['demo_contacts_4'] },
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

  // The demo's tasks table is the project template PLUS both arities of
  // cross-table reference, expressed in the same template column format
  // (issue 341282fe) — not patched on afterwards. Which contact column labels
  // a linked row is stored explicitly (`reference_display_column`), never
  // guessed at read time.
  const projectWithRefs = {
    ...project,
    columns: [
      ...project.columns,
      {
        id: 'client',
        name: 'Client',
        column_type: 'reference',
        reference_table: 'contacts',
        reference_display_column: 'name',
      },
      {
        id: 'stakeholders',
        name: 'Stakeholders',
        column_type: 'multireference',
        reference_table: 'contacts',
        reference_display_column: 'name',
      },
    ],
  }
  await cws.createTable(JSON.stringify(buildTableDefinition('tasks', 'Projects', projectWithRefs)))
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
        // Explicit view setting (never inferred): the demo shows the member
        // column on cards.
        assignee_column: 'assignee',
      },
    }),
  )

  // A second board over the same table, filtered to the viewer — the `@me`
  // value resolves per-viewer, so this is everyone's own board.
  await cws.createView(
    JSON.stringify({
      id: 'tasks-mine',
      name: 'My Board',
      table_id: 'tasks',
      view_type: 'kanban',
      sort: [],
      filters: [{ column_id: 'assignee', operator: 'equals', value: '@me' }],
      kanban_config: {
        group_by_column: 'status',
        title_column: 'title',
        display_columns: [],
        column_options: project.columns.find(c => c.id === 'status')?.options ?? [],
        assignee_column: 'assignee',
      },
    }),
  )

  const writeRows = async (tableId: string, rows: Row[]) => {
    for (const [i, row] of rows.entries()) {
      for (const [col, value] of Object.entries(row)) {
        if (value === '' || value == null) continue
        if (Array.isArray(value) && value.length === 0) continue
        const resolved = value === SELF ? selfUserId : value
        if (resolved === '' || resolved == null) continue
        await cws.updateCell(tableId, rowId(tableId, i), col, JSON.stringify(resolved))
      }
    }
  }
  await writeRows('tasks', TASKS)
  await writeRows('contacts', CONTACTS)
}
