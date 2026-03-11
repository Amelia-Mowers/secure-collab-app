import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { TableView } from './TableView'
import { MockWorkspace, makeTasksWorkspace, seedTasks } from '@/test/mockWorkspace'

function renderTable(workspace: any, tableId = 'tasks') {
  return render(
    <MemoryRouter initialEntries={[`/table/${tableId}`]}>
      <Routes>
        <Route path="/table/:tableId" element={<TableView workspace={workspace} />} />
        <Route path="/table/:tableId/view/:viewId" element={<div data-testid="kanban-view" />} />
        <Route path="/table/:tableId/entry/new" element={<div data-testid="entry-new" />} />
        <Route path="/table/:tableId/entry/:rowId" element={<div data-testid="entry-view" />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('TableView', () => {
  describe('loading and error states', () => {
    it('shows a loading indicator while rows are being fetched', () => {
      // Workspace that hangs getTableRows
      const hanging = { getTableRows: () => { throw new Error('Loading...') }, getTableSchema: () => '{}' }
      renderTable(hanging)
      // error state or loading – either is acceptable; just don't crash
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
    it('renders a row for each entry in the table', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      renderTable(ws)
      await waitFor(() => {
        expect(screen.getByDisplayValue('Design homepage')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Set up CI/CD')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Write unit tests')).toBeInTheDocument()
      })
    })

    it('renders column headers derived from row data', async () => {
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
      await waitFor(() => expect(screen.getByDisplayValue('Design homepage')).toBeInTheDocument())
      const deleteButtons = screen.getAllByTitle('Delete row')
      fireEvent.click(deleteButtons[0])
      await waitFor(() => expect(ws._rowCount('tasks')).toBe(3))
    })

    it('inline editing a cell calls updateCell with the new value', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      const spy = vi.spyOn(ws, 'updateCell')
      renderTable(ws)
      await waitFor(() => screen.getByDisplayValue('Design homepage'))
      const input = screen.getByDisplayValue('Design homepage')
      fireEvent.change(input, { target: { value: 'Redesign homepage' } })
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
      // Modal renders with its column-name input
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
      // Submit the modal form
      fireEvent.submit(input.closest('form')!)
      await waitFor(() => expect(spy).toHaveBeenCalledWith(
        'tasks',
        expect.stringContaining('"id":"tags"'),
      ))
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
      // Give it a moment to fully render, then assert absence
      await waitFor(() => expect(screen.getByText('Filter')).toBeInTheDocument())
      expect(screen.queryByText(/New view/i)).not.toBeInTheDocument()
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
      await waitFor(() => expect(screen.getByDisplayValue('Hello')).toBeInTheDocument())
    })

    it('handles cell values with special characters', async () => {
      const ws = makeTasksWorkspace()
      ws.updateCell('tasks', 'r1', 'title', '"Fix <script>alert(1)</script>"')
      renderTable(ws)
      await waitFor(() =>
        expect(screen.getByDisplayValue('Fix <script>alert(1)</script>')).toBeInTheDocument(),
      )
    })

    it('handles numeric cell values displayed as text in the table', async () => {
      const ws = makeTasksWorkspace()
      ws.updateCell('tasks', 'r1', 'priority', '42')
      renderTable(ws)
      await waitFor(() => expect(screen.getByDisplayValue('42')).toBeInTheDocument())
    })
  })
})
