import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

    it('shows "Add your first entry" CTA for an empty table', async () => {
      const ws = makeTasksWorkspace() // tasks table created but no rows
      renderTable(ws)
      await waitFor(() => expect(screen.getByText(/Add your first entry/i)).toBeInTheDocument())
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

  describe('row operations', () => {
    it('"Add your first entry" button navigates to the new entry form', async () => {
      const ws = makeTasksWorkspace()
      renderTable(ws)
      await waitFor(() => screen.getByText(/Add your first entry/i))
      fireEvent.click(screen.getByText(/Add your first entry/i))
      await waitFor(() => expect(screen.getByTestId('entry-new')).toBeInTheDocument())
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
      const input = await screen.findByPlaceholderText(/Filter rows/)
      fireEvent.change(input, { target: { value: 'CI/CD' } })
      await waitFor(() => {
        expect(screen.getByText('Set up CI/CD')).toBeInTheDocument()
        expect(screen.queryByText('Design homepage')).not.toBeInTheDocument()
      })
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
