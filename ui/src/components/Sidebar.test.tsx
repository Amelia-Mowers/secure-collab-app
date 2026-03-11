import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { MockWorkspace, makeKanbanWorkspace } from '@/test/mockWorkspace'

function renderSidebar(workspace: any, initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Sidebar workspace={workspace} username="Alice" workspaceId="ws_test" />
      <Routes>
        <Route path="/table/:tableId" element={<div data-testid="table-view" />} />
        <Route path="/table/:tableId/view/:viewId" element={<div data-testid="view-route" />} />
        <Route path="/workspaces" element={<div data-testid="workspaces-page" />} />
        <Route path="/" element={<div data-testid="home" />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Sidebar', () => {
  describe('empty workspace', () => {
    it('shows "No tables yet" when the workspace has no tables', () => {
      const ws = new MockWorkspace()
      renderSidebar(ws)
      expect(screen.getByText('No tables yet')).toBeInTheDocument()
    })

    it('shows "No views yet" when there are no views', () => {
      const ws = new MockWorkspace()
      renderSidebar(ws)
      expect(screen.getByText('No views yet')).toBeInTheDocument()
    })

    it('shows a "New table" button', () => {
      const ws = new MockWorkspace()
      renderSidebar(ws)
      expect(screen.getByText('New table')).toBeInTheDocument()
    })

    it('shows a "New view" button', () => {
      const ws = new MockWorkspace()
      renderSidebar(ws)
      expect(screen.getByText('New view')).toBeInTheDocument()
    })
  })

  describe('Tables section', () => {
    it('lists each table in the workspace', () => {
      const ws = makeKanbanWorkspace() // has "tasks" table (name: "Tasks")
      renderSidebar(ws)
      // "Tasks" appears as the table label AND as a badge on the view — use getAllByText
      const labels = screen.getAllByText('Tasks')
      expect(labels.length).toBeGreaterThanOrEqual(1)
    })

    it('lists multiple tables', () => {
      const ws = new MockWorkspace()
      ws.createTable(JSON.stringify({ id: 'tasks',    name: 'Tasks',    columns: {} }))
      ws.createTable(JSON.stringify({ id: 'projects', name: 'Projects', columns: {} }))
      ws.createTable(JSON.stringify({ id: 'bugs',     name: 'Bugs',     columns: {} }))
      renderSidebar(ws)
      expect(screen.getByText('Tasks')).toBeInTheDocument()
      expect(screen.getByText('Projects')).toBeInTheDocument()
      expect(screen.getByText('Bugs')).toBeInTheDocument()
    })

    it('does NOT show views nested under tables (flat layout)', () => {
      const ws = makeKanbanWorkspace()
      renderSidebar(ws)
      // In the new sidebar views are in their own section, not nested under tables.
      // "Task Board" (view name) should be visible directly — not hidden behind an expand.
      expect(screen.getByText('Task Board')).toBeInTheDocument()
    })

    it('does not show a collapse chevron next to tables', () => {
      const ws = makeKanbanWorkspace()
      renderSidebar(ws)
      // Old design had chevrons. New sidebar has no per-table expand/collapse.
      expect(screen.queryByTitle('expand')).not.toBeInTheDocument()
    })
  })

  describe('Views section', () => {
    it('shows a "Views" section header', () => {
      const ws = new MockWorkspace()
      renderSidebar(ws)
      expect(screen.getByText('Views')).toBeInTheDocument()
    })

    it('lists views from all tables in the Views section', () => {
      const ws = makeKanbanWorkspace()
      renderSidebar(ws)
      expect(screen.getByText('Task Board')).toBeInTheDocument()
    })

    it('shows the parent table name as a badge next to each view', () => {
      const ws = makeKanbanWorkspace()
      renderSidebar(ws)
      // "Tasks" appears as the table badge for "Task Board"
      // There will be two "Tasks" labels: one table item, one badge.
      const taskLabels = screen.getAllByText('Tasks')
      expect(taskLabels.length).toBeGreaterThanOrEqual(2)
    })

    it('lists views from multiple tables', () => {
      const ws = new MockWorkspace()
      ws.createTable(JSON.stringify({ id: 'tasks',    name: 'Tasks',    columns: {} }))
      ws.createTable(JSON.stringify({ id: 'projects', name: 'Projects', columns: {} }))
      ws.createView(JSON.stringify({
        id: 'board1', name: 'Sprint Board', table_id: 'tasks',
        view_type: 'kanban', sort: [], filters: [],
        kanban_config: { group_by_column: 'status', title_column: 'title', display_columns: [], column_options: [] },
      }))
      ws.createView(JSON.stringify({
        id: 'board2', name: 'Project Tracker', table_id: 'projects',
        view_type: 'kanban', sort: [], filters: [],
        kanban_config: { group_by_column: 'status', title_column: 'title', display_columns: [], column_options: [] },
      }))
      renderSidebar(ws)
      expect(screen.getByText('Sprint Board')).toBeInTheDocument()
      expect(screen.getByText('Project Tracker')).toBeInTheDocument()
    })
  })

  describe('table creation', () => {
    it('clicking "New table" reveals the new-table input', () => {
      const ws = new MockWorkspace()
      renderSidebar(ws)
      fireEvent.click(screen.getByText('New table'))
      expect(screen.getByPlaceholderText('Table name...')).toBeInTheDocument()
    })

    it('submitting a table name creates the table', async () => {
      const ws = new MockWorkspace()
      const spy = vi.spyOn(ws, 'createTable')
      renderSidebar(ws)
      fireEvent.click(screen.getByText('New table'))
      const input = screen.getByPlaceholderText('Table name...')
      fireEvent.change(input, { target: { value: 'Meeting Notes' } })
      fireEvent.submit(input.closest('form')!)
      await waitFor(() => expect(spy).toHaveBeenCalled())
      expect(screen.queryByPlaceholderText('Table name...')).not.toBeInTheDocument()
    })

    it('converts table name to kebab-case for the table ID', async () => {
      const ws = new MockWorkspace()
      const spy = vi.spyOn(ws, 'createTable')
      renderSidebar(ws)
      fireEvent.click(screen.getByText('New table'))
      const input = screen.getByPlaceholderText('Table name...')
      fireEvent.change(input, { target: { value: 'My New Table' } })
      fireEvent.submit(input.closest('form')!)
      await waitFor(() => expect(spy).toHaveBeenCalled())
      const callArg = JSON.parse(spy.mock.calls[0][0])
      expect(callArg.id).toBe('my-new-table')
      expect(callArg.name).toBe('My New Table')
    })

    it('does not create a table if the name is blank', () => {
      const ws = new MockWorkspace()
      const spy = vi.spyOn(ws, 'createTable')
      renderSidebar(ws)
      fireEvent.click(screen.getByText('New table'))
      const form = screen.getByPlaceholderText('Table name...').closest('form')
      if (form) fireEvent.submit(form)
      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('navigation', () => {
    it('clicking a table navigates to /table/:tableId', () => {
      const ws = makeKanbanWorkspace()
      renderSidebar(ws)
      // "Tasks" appears as both the table label and as a badge in the view item.
      // Click the one that is inside a table-section button (the first label match).
      const taskLabels = screen.getAllByText('Tasks')
      // The table item label is a sidebar__item-label span; click the button containing it
      const tableBtn = taskLabels.find(el => el.classList.contains('sidebar__item-label'))?.closest('button')
      if (tableBtn) {
        fireEvent.click(tableBtn)
      } else {
        fireEvent.click(taskLabels[0])
      }
      expect(screen.getByTestId('table-view')).toBeInTheDocument()
    })

    it('clicking a view in the Views section navigates to the view route', () => {
      const ws = makeKanbanWorkspace()
      renderSidebar(ws)
      fireEvent.click(screen.getByText('Task Board'))
      expect(screen.getByTestId('view-route')).toBeInTheDocument()
    })

    it('active table is highlighted when current path matches', () => {
      const ws = makeKanbanWorkspace()
      renderSidebar(ws, '/table/tasks')
      // "Tasks" appears as table label AND as a badge; find the label span inside a button
      const taskLabels = screen.getAllByText('Tasks')
      const tableBtn = taskLabels.find(el => el.classList.contains('sidebar__item-label'))?.closest('button')
      expect(tableBtn).toBeTruthy()
      expect(tableBtn!.className).toContain('sidebar__item--active')
    })

    it('active view is highlighted when current path matches', () => {
      const ws = makeKanbanWorkspace()
      renderSidebar(ws, '/table/tasks/view/tasks-kanban')
      const viewBtn = screen.getByTestId('view-item-tasks-kanban')
      expect(viewBtn.className).toContain('sidebar__item--active')
    })
  })

  describe('collapse', () => {
    it('clicking the workspace name collapses the sidebar', () => {
      const ws = new MockWorkspace()
      renderSidebar(ws)
      const nameEl = screen.getByText('Workspace')
      fireEvent.click(nameEl)
      // Tables/Views sections should no longer be visible
      expect(screen.queryByText('No tables yet')).not.toBeInTheDocument()
    })

    it('clicking the workspace name again re-expands the sidebar', () => {
      const ws = new MockWorkspace()
      renderSidebar(ws)
      const nameEl = screen.getByText('Workspace')
      fireEvent.click(nameEl) // collapse
      // After collapsing the workspace-text is hidden; click the logo instead
      const logo = document.querySelector('.sidebar__logo')!
      fireEvent.click(logo) // re-expand
      expect(screen.getByText('No tables yet')).toBeInTheDocument()
    })
  })

  describe('workspaces navigation', () => {
    it('clicking "All workspaces" button navigates to /workspaces', () => {
      const ws = new MockWorkspace()
      renderSidebar(ws)
      const backBtn = screen.getByTitle('All workspaces')
      fireEvent.click(backBtn)
      expect(screen.getByTestId('workspaces-page')).toBeInTheDocument()
    })

    it('the "All workspaces" button is hidden when sidebar is collapsed', () => {
      const ws = new MockWorkspace()
      renderSidebar(ws)
      const nameEl = screen.getByText('Workspace')
      fireEvent.click(nameEl) // collapse
      expect(screen.queryByTitle('All workspaces')).not.toBeInTheDocument()
    })
  })
})
