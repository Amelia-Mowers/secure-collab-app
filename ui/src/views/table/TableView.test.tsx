import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { TableView } from './TableView'
import { MockWorkspace, makeTasksWorkspace, seedTasks } from '@/test/mockWorkspace'

function renderTable(workspace: any, tableId = 'tasks') {
  return render(
    <MemoryRouter initialEntries={[`/workspace/ws_test/table/${tableId}`]}>
      <Routes>
        <Route path="/workspace/:workspaceId/table/:tableId" element={<TableView workspace={workspace} />} />
        <Route path="/workspace/:workspaceId/table/:tableId/view/:viewId" element={<div data-testid="kanban-view" />} />
        <Route path="/workspace/:workspaceId/table/:tableId/entry/new" element={<div data-testid="entry-new" />} />
        <Route path="/workspace/:workspaceId/table/:tableId/entry/:rowId" element={<div data-testid="entry-view" />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('TableView', () => {
  describe('loading and error states', () => {
    it('shows a loading indicator while rows are being fetched', () => {
      const hanging = { getTableRows: () => { throw new Error('Loading...') }, getTableSchema: () => '{}' }
      renderTable(hanging)
      expect(document.body).toBeInTheDocument()
    })

    it('shows an error message when getTableRows throws', async () => {
      const broken = {
        getTableRows: () => { throw new Error('Connection lost') },
        getTableSchema: () => JSON.stringify({ id: 'tasks', name: 'Tasks', columns: {} }),
      }
      renderTable(broken)
      await waitFor(() => expect(screen.getByText(/Connection lost/i)).toBeInTheDocument())
    })

    it('shows the inline shadow quick-add row for an empty table (issue c79ce975)', async () => {
      const ws = makeTasksWorkspace() // tasks table created but no rows
      const { container } = renderTable(ws)
      await waitFor(() => expect(container.querySelector('.row-shadow')).toBeInTheDocument())
      // The old separate CTA is gone — the first entry is added inline.
      expect(screen.queryByText(/Add your first entry/i)).not.toBeInTheDocument()
    })
  })

  describe('rendering rows', () => {
    // Cells now render compact read-only display text (click to edit), so we
    // assert on text content rather than input display values.
    it('renders a row for each entry in the table', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      renderTable(ws)
      await waitFor(() => {
        expect(screen.getByText('Design homepage')).toBeInTheDocument()
        expect(screen.getByText('Set up CI/CD')).toBeInTheDocument()
        expect(screen.getByText('Write unit tests')).toBeInTheDocument()
      })
    })

    it('renders column headers derived from the schema', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      renderTable(ws)
      await waitFor(() => {
        expect(screen.getByText('Title')).toBeInTheDocument()
        expect(screen.getByText('Status')).toBeInTheDocument()
        expect(screen.getByText('Assignee')).toBeInTheDocument()
      })
    })

    it('renders a delete button for each row', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      renderTable(ws)
      await waitFor(() => {
        const deleteButtons = screen.getAllByTitle('Delete row')
        expect(deleteButtons).toHaveLength(4)
      })
    })

    it('renders the drag handle and open-entry button as separate controls', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      renderTable(ws)
      await waitFor(() => {
        // One of each per row, and they are distinct elements.
        const handles = screen.getAllByLabelText('Drag to reorder')
        const openers = screen.getAllByLabelText('Open full entry')
        expect(handles).toHaveLength(4)
        expect(openers).toHaveLength(4)
        expect(handles[0]).not.toBe(openers[0])
      })
    })
  })

  describe('reference cells (issue c14e01a0)', () => {
    /** tasks.client → contacts, labelled by the contact's `name`. */
    function workspaceWithReference(displayColumn?: string) {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      ws.createTable(JSON.stringify({
        id: 'contacts',
        name: 'Contacts',
        columns: {
          name: { id: 'name', name: 'Name', column_type: 'text', order: 0 },
          email: { id: 'email', name: 'Email', column_type: 'text', order: 1 },
        },
      }))
      ws.updateCell('contacts', 'c1', 'name', JSON.stringify('Dana Whitfield'))
      ws.updateCell('contacts', 'c1', 'email', JSON.stringify('dana@acme.test'))
      ws.addColumn('tasks', JSON.stringify({
        id: 'client',
        name: 'Client',
        column_type: 'reference',
        reference_table: 'contacts',
        ...(displayColumn ? { reference_display_column: displayColumn } : {}),
      }))
      ws.updateCell('tasks', 'task-1', 'client', JSON.stringify('c1'))
      return ws
    }

    it('renders a referenced row through its display column, not its id', async () => {
      renderTable(workspaceWithReference('email'))
      await waitFor(() => expect(screen.getByText('dana@acme.test')).toBeInTheDocument())
      expect(screen.queryByText('c1')).not.toBeInTheDocument()
    })

    it('falls back to the first text column when none is configured', async () => {
      renderTable(workspaceWithReference())
      await waitFor(() => expect(screen.getByText('Dana Whitfield')).toBeInTheDocument())
    })

    it('shows a reference to a missing row as its raw id', async () => {
      const ws = workspaceWithReference('name')
      ws.updateCell('tasks', 'task-2', 'client', JSON.stringify('c_gone'))
      const { container } = renderTable(ws)
      await waitFor(() => expect(screen.getByText('c_gone')).toBeInTheDocument())
      expect(container.querySelector('.cell-ref--dangling')).toBeInTheDocument()
    })
  })

  describe('row operations', () => {
    it('adds the first entry inline by editing the shadow row on an empty table', async () => {
      const ws = makeTasksWorkspace() // no rows yet
      const { container } = renderTable(ws)
      await waitFor(() => expect(container.querySelector('.row-shadow')).toBeInTheDocument())
      // Click the first shadow cell, type a value, commit on blur → real row.
      const shadowCell = container.querySelector('.row-shadow .cell-click') as HTMLElement
      fireEvent.click(shadowCell)
      const input = await waitFor(() => screen.getByRole('textbox'))
      fireEvent.change(input, { target: { value: 'First task' } })
      fireEvent.blur(input)
      await waitFor(() => expect(ws._rowCount('tasks')).toBe(1))
    })

    it('deleting a row removes it from the table', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      renderTable(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      const deleteButtons = screen.getAllByTitle('Delete row')
      fireEvent.click(deleteButtons[0])
      await waitFor(() => expect(ws._rowCount('tasks')).toBe(3))
    })

    it('click-to-edit commits a single updateCell on blur (not per keystroke)', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      const spy = vi.spyOn(ws, 'updateCell')
      renderTable(ws)
      await waitFor(() => screen.getByText('Design homepage'))

      // Click the cell to enter edit mode, then type and blur to commit.
      fireEvent.click(screen.getByText('Design homepage'))
      const input = await screen.findByDisplayValue('Design homepage')
      const callsBefore = spy.mock.calls.length
      fireEvent.change(input, { target: { value: 'Redesign homepage' } })
      // No commit yet — editing in progress.
      expect(spy.mock.calls.length).toBe(callsBefore)
      fireEvent.blur(input)

      await waitFor(() => expect(spy).toHaveBeenCalledWith(
        'tasks',
        expect.any(String),
        'title',
        '"Redesign homepage"',
      ))
    })
  })

  describe('column operations', () => {
    it('shows an Add Column (+) button', async () => {
      const ws = makeTasksWorkspace()
      renderTable(ws)
      await waitFor(() => expect(screen.getByTitle('Add column')).toBeInTheDocument())
    })

    it('clicking Add Column opens the Add Column modal', async () => {
      const ws = makeTasksWorkspace()
      renderTable(ws)
      await waitFor(() => screen.getByTitle('Add column'))
      fireEvent.click(screen.getByTitle('Add column'))
      expect(screen.getByPlaceholderText('e.g. Priority')).toBeInTheDocument()
    })

    it('submitting the Add Column modal creates the column', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      const spy = vi.spyOn(ws, 'addColumn')
      renderTable(ws)
      await waitFor(() => screen.getByTitle('Add column'))
      fireEvent.click(screen.getByTitle('Add column'))
      const input = screen.getByPlaceholderText('e.g. Priority')
      fireEvent.change(input, { target: { value: 'Tags' } })
      fireEvent.submit(input.closest('form')!)
      await waitFor(() => expect(spy).toHaveBeenCalledWith(
        'tasks',
        expect.stringContaining('"id":"tags"'),
      ))
    })

    it('Edit column opens a prefilled modal and saves changes via updateColumn', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      const spy = vi.spyOn(ws, 'updateColumn')
      renderTable(ws)
      await waitFor(() => screen.getByText('Assignee'))
      // Open the first column's ⋯ menu and choose Edit.
      fireEvent.click(screen.getAllByLabelText('Column options')[0])
      fireEvent.click(await screen.findByText('Edit column…'))
      // The modal is prefilled with the column's current name.
      const nameInput = (await screen.findByPlaceholderText('e.g. Priority')) as HTMLInputElement
      expect(nameInput.value.length).toBeGreaterThan(0)
      fireEvent.change(nameInput, { target: { value: 'Renamed' } })
      fireEvent.click(screen.getByText('Save changes'))
      await waitFor(() => expect(spy).toHaveBeenCalledWith(
        'tasks',
        expect.any(String),
        expect.stringContaining('"name":"Renamed"'),
      ))
    })

    it('Auto-detect fills Select options from the column\'s existing values', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      renderTable(ws)
      // First column by id order is "assignee" (text), with Alice/Bob/Charlie.
      await waitFor(() => screen.getByText('Assignee'))
      fireEvent.click(screen.getAllByLabelText('Column options')[0])
      fireEvent.click(await screen.findByText('Edit column…'))
      // Switch the type to Select, then auto-detect options from the data.
      fireEvent.click(screen.getByText('Select'))
      fireEvent.click(await screen.findByText(/Auto-detect from data/i))
      const optionsInput = screen.getByPlaceholderText('Todo, In Progress, Done') as HTMLInputElement
      expect(optionsInput.value).toContain('Alice')
      expect(optionsInput.value).toContain('Bob')
      expect(optionsInput.value).toContain('Charlie')
    })
  })

  describe('column layout (issue 848dcbf7)', () => {
    /** A saved table view over `tasks` with the given layout config. */
    function viewWithLayout(tableConfig: Record<string, unknown>) {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      ws.createView(JSON.stringify({
        id: 'grid',
        name: 'Grid',
        table_id: 'tasks',
        view_type: 'table',
        sort: [],
        filters: [],
        table_config: tableConfig,
      }))
      return ws
    }

    function renderView(workspace: any) {
      return render(
        <MemoryRouter initialEntries={['/workspace/ws_test/table/tasks/view/grid']}>
          <Routes>
            <Route
              path="/workspace/:workspaceId/table/:tableId/view/:viewId"
              element={<TableView workspace={workspace} />}
            />
          </Routes>
        </MemoryRouter>,
      )
    }

    it('uses fixed layout so long content truncates instead of widening the grid', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      const { container } = renderTable(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      // Auto layout is what made a max-width unenforceable on a doc preview.
      expect(container.querySelector('table.data-table')).toBeInTheDocument()
      // One <col> per visible column, plus the leading and actions columns.
      expect(container.querySelectorAll('colgroup col').length).toBeGreaterThan(2)
    })

    it("applies a column's saved width, wherever it's viewed (issue a96dfc71)", async () => {
      // Width is COLUMN metadata, not a view setting — so it applies on the raw
      // table too, and every collaborator sees the same layout.
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      ws.setColumnWidth('tasks', 'title', 420)
      const { container } = renderTable(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      const cols = Array.from(container.querySelectorAll('colgroup col')) as HTMLElement[]
      expect(cols.some(c => c.style.width === '420px')).toBe(true)
    })

    it('derives a sensible default width from the column type (issue 93ffe164)', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      const { container } = renderTable(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      const widths = (Array.from(container.querySelectorAll('colgroup col')) as HTMLElement[])
        .map(c => parseInt(c.style.width, 10))
        .filter(Number.isFinite)
      // A checkbox column must not get the same room as a text column.
      expect(Math.min(...widths)).toBeLessThan(Math.max(...widths))
      expect(Math.min(...widths)).toBeLessThanOrEqual(80)
    })

    it("hides the columns a view hides, without touching their data", async () => {
      const ws = viewWithLayout({ hidden_columns: ['assignee'] })
      renderView(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      expect(screen.queryAllByText('Alice')).toHaveLength(0)
      // Still in the schema — the row data is untouched, this is presentation.
      expect(JSON.parse(ws.getTableRows('tasks'))[0].assignee).toBe('Alice')
    })

    it('restores a hidden column from the Columns menu', async () => {
      const ws = viewWithLayout({ hidden_columns: ['assignee'] })
      renderView(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      expect(screen.queryAllByText('Alice')).toHaveLength(0)
      fireEvent.click(screen.getByText('Columns'))
      fireEvent.click(screen.getByText('Show all'))
      // Two seeded tasks are assigned to Alice.
      await waitFor(() => expect(screen.queryAllByText('Alice')).toHaveLength(2))
    })
  })

  describe('multi-row selection + bulk edit (issue bae5a235)', () => {
    const selectRow = (n: number) =>
      fireEvent.click(screen.getAllByLabelText(/^Select entry /)[n])

    it('shows the bulk bar only once something is selected', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      renderTable(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument()
      selectRow(0)
      expect(screen.getByText('1 selected')).toBeInTheDocument()
    })

    it('selects and clears every displayed row from the header checkbox', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws) // 4 rows
      renderTable(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      const all = screen.getByLabelText('Select all entries')
      fireEvent.click(all)
      expect(screen.getByText('4 selected')).toBeInTheDocument()
      fireEvent.click(all)
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument()
    })

    it('writes one value into that column of every selected row', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      renderTable(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      fireEvent.click(screen.getByLabelText('Select all entries'))
      // First combobox picks the column; that renders the column's OWN editor
      // as the second — a select column gets its options, for free.
      fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'status' } })
      const valueEditor = screen.getAllByRole('combobox')[1]
      expect(within(valueEditor).getByRole('option', { name: 'Done' })).toBeInTheDocument()
      fireEvent.change(valueEditor, { target: { value: 'Done' } })
      await waitFor(() => {
        const rows = JSON.parse(ws.getTableRows('tasks'))
        expect(rows.every((r: any) => r.status === 'Done')).toBe(true)
      })
    })

    it('requires a second click to delete the selection', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      renderTable(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      selectRow(0)
      fireEvent.click(screen.getByText('Delete'))
      // Nothing gone yet — the first click only arms the confirm.
      expect(JSON.parse(ws.getTableRows('tasks'))).toHaveLength(4)
      fireEvent.click(screen.getByText(/^Delete 1 — confirm$/))
      await waitFor(() => expect(JSON.parse(ws.getTableRows('tasks'))).toHaveLength(3))
    })
  })

  describe('viewer role is read-only (workspace roles)', () => {
    /** A workspace whose bridge reports this user as a viewer. */
    function asViewer() {
      const ws: any = makeTasksWorkspace()
      seedTasks(ws)
      ws.myRole = () => Promise.resolve('viewer')
      return ws
    }

    it('hides every write affordance', async () => {
      const ws = asViewer()
      const { container } = renderTable(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      expect(screen.queryByText('New entry')).not.toBeInTheDocument()
      expect(screen.queryByTitle('Add column')).not.toBeInTheDocument()
      expect(container.querySelector('.cell-delete-btn')).not.toBeInTheDocument()
    })

    it('does not open an editor when a cell is clicked', async () => {
      const ws = asViewer()
      renderTable(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      fireEvent.click(screen.getByText('Design homepage'))
      // The cell stays display-only — no input takes its place.
      expect(screen.getByText('Design homepage')).toBeInTheDocument()
      expect(screen.queryByDisplayValue('Design homepage')).not.toBeInTheDocument()
    })

    it('still shows the data — view-only, not access-denied', async () => {
      const ws = asViewer()
      renderTable(ws)
      await waitFor(() => {
        expect(screen.getByText('Design homepage')).toBeInTheDocument()
        expect(screen.getByText('Write unit tests')).toBeInTheDocument()
      })
    })

    it('keeps write affordances for an editor', async () => {
      const ws: any = makeTasksWorkspace()
      seedTasks(ws)
      ws.myRole = () => Promise.resolve('editor')
      renderTable(ws)
      await waitFor(() => expect(screen.getByText('New entry')).toBeInTheDocument())
    })
  })

  describe('toolbar', () => {
    it('shows a Filter button in the toolbar', async () => {
      const ws = makeTasksWorkspace()
      renderTable(ws)
      await waitFor(() => expect(screen.getByText('Filter')).toBeInTheDocument())
    })

    it('shows a "New entry" primary button', async () => {
      const ws = makeTasksWorkspace()
      renderTable(ws)
      await waitFor(() => expect(screen.getByText('New entry')).toBeInTheDocument())
    })

    it('does not have a "New view" button (new views are created from the sidebar)', async () => {
      const ws = makeTasksWorkspace()
      renderTable(ws)
      await waitFor(() => expect(screen.getByText('Filter')).toBeInTheDocument())
      expect(screen.queryByText(/New view/i)).not.toBeInTheDocument()
    })
  })

  describe('filtering', () => {
    it('filters rows via the global filter input', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      renderTable(ws)
      await waitFor(() => screen.getByText('Design homepage'))
      fireEvent.click(screen.getByText('Filter'))
      const input = await screen.findByPlaceholderText(/Search all columns/)
      fireEvent.change(input, { target: { value: 'CI/CD' } })
      await waitFor(() => {
        expect(screen.getByText('Set up CI/CD')).toBeInTheDocument()
        expect(screen.queryByText('Design homepage')).not.toBeInTheDocument()
      })
    })

    it('adds a per-column "where" condition from the filter bar', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      renderTable(ws)
      await waitFor(() => screen.getByText('Design homepage'))
      fireEvent.click(screen.getByText('Filter'))
      fireEvent.click(await screen.findByText('+ Add condition'))
      // A condition row is created (lead label + save affordance present).
      expect(screen.getByText('Where')).toBeInTheDocument()
      // Raw table (no saved view open) → "Save view" creates one.
      expect(screen.getByText('Save view')).toBeInTheDocument()
      // Reset clears the ephemeral condition (raw table → no filters).
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
      expect(screen.queryByText('Where')).not.toBeInTheDocument()
    })
  })

  describe('edge cases', () => {
    it('handles tables with a single column', async () => {
      const ws = new MockWorkspace()
      ws.createTable(JSON.stringify({
        id: 'simple', name: 'Simple', columns: {
          name: { id: 'name', name: 'Name', column_type: 'text', required: false },
        },
      }))
      ws.updateCell('simple', 'r1', 'name', '"Hello"')
      renderTable(ws, 'simple')
      await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument())
    })

    it('handles cell values with special characters', async () => {
      const ws = makeTasksWorkspace()
      ws.updateCell('tasks', 'r1', 'title', '"Fix <script>alert(1)</script>"')
      renderTable(ws)
      await waitFor(() =>
        expect(screen.getByText('Fix <script>alert(1)</script>')).toBeInTheDocument(),
      )
    })

    it('handles numeric cell values displayed as text in the table', async () => {
      const ws = makeTasksWorkspace()
      ws.updateCell('tasks', 'r1', 'priority', '42')
      renderTable(ws)
      await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument())
    })
  })

  describe('keyboard navigation', () => {
    it('Enter moves edit focus to the cell below in the same column', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      renderTable(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())

      // Edit the first row's title, then press Enter.
      fireEvent.click(screen.getByText('Design homepage').closest('.cell-click')!)
      const input = await screen.findByDisplayValue('Design homepage')
      fireEvent.keyDown(input, { key: 'Enter' })

      // Edit focus should land on the next row's title cell (commit fired too,
      // but the value was unchanged).
      await waitFor(() =>
        expect(screen.getByDisplayValue('Set up CI/CD')).toBeInTheDocument(),
      )
    })
  })
})
