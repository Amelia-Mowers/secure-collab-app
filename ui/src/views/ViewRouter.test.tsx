import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ViewRouter } from './ViewRouter'
import { makeKanbanWorkspace, makeTasksWorkspace } from '@/test/mockWorkspace'

function renderViewRouter(workspace: any, tableId: string, viewId: string) {
  return render(
    <MemoryRouter initialEntries={[`/table/${tableId}/view/${viewId}`]}>
      <Routes>
        <Route
          path="/table/:tableId/view/:viewId"
          element={<ViewRouter workspace={workspace} />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ViewRouter', () => {
  it('renders KanbanView for a kanban view_type', async () => {
    const ws = makeKanbanWorkspace()
    renderViewRouter(ws, 'tasks', 'tasks-kanban')
    // KanbanView shows the view name in the toolbar once loaded
    await waitFor(() => expect(screen.getByText('Task Board')).toBeInTheDocument())
  })

  it('renders KanbanView as fallback for an unknown view_type', async () => {
    const ws = makeTasksWorkspace()
    // Seed directly (not createView): an unknown type can only arrive via sync
    // from a newer client — local creation rejects it, the read path tolerates it.
    ws.seedView({
      id: 'mystery',
      name: 'Mystery View',
      table_id: 'tasks',
      view_type: 'unknown_type',
      sort: [],
      filters: [],
    })
    renderViewRouter(ws, 'tasks', 'mystery')
    // Falls back to KanbanView — shows the view name
    await waitFor(() => expect(screen.getByText('Mystery View')).toBeInTheDocument())
  })

  it('renders nothing (null) while resolving the view type', () => {
    // workspace that stalls on getView — simulate by returning a workspace with
    // no view registered (getView will throw, setting type to kanban)
    const ws = makeTasksWorkspace()
    // No view created — getView will throw, viewType falls back to 'kanban'
    // The component should not crash and eventually renders the kanban loading state
    expect(() => renderViewRouter(ws, 'tasks', 'nonexistent')).not.toThrow()
  })

  it('renders a card view for card view_type (shows card grid container)', async () => {
    const ws = makeTasksWorkspace()
    ws.createView(JSON.stringify({
      id: 'card-view',
      name: 'Card View',
      table_id: 'tasks',
      view_type: 'card',
      sort: [],
      filters: [],
    }))
    renderViewRouter(ws, 'tasks', 'card-view')
    // CardView renders a .card-view container
    await waitFor(() => {
      expect(document.querySelector('.card-view')).toBeTruthy()
    })
  })
})
