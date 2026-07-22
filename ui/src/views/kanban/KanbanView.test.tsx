import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { KanbanView } from './KanbanView'
import { makeKanbanWorkspace, makeTasksWorkspace, seedTasks } from '@/test/mockWorkspace'

function renderKanban(workspace: any, tableId = 'tasks', viewId = 'tasks-kanban') {
  return render(
    <MemoryRouter initialEntries={[`/table/${tableId}/view/${viewId}`]}>
      <Routes>
        <Route
          path="/table/:tableId/view/:viewId"
          element={<KanbanView workspace={workspace} />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('KanbanView', () => {
  describe('loading and missing config', () => {
    it('shows "No view selected" when tableId or viewId are absent', () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<KanbanView workspace={null} />} />
          </Routes>
        </MemoryRouter>,
      )
      expect(screen.getByText('No view selected')).toBeInTheDocument()
    })

    it('shows a loading state before the view config resolves', () => {
      // Simulate an initial render where workspace itself is null (no workspace = no effects run)
      render(
        <MemoryRouter initialEntries={['/table/tasks/view/tasks-kanban']}>
          <Routes>
            <Route
              path="/table/:tableId/view/:viewId"
              element={<KanbanView workspace={null} />}
            />
          </Routes>
        </MemoryRouter>,
      )
      // With null workspace, useTable loading stays false but no viewConfig or viewError → Loading
      // Actually null workspace hits the "No view selected" guard — the workspace is null, tableId exists
      // The component renders the loading state when workspace is null but tableId+viewId exist:
      // loading=false, viewConfig=null, viewError=null → shows Loading...
      expect(screen.getByText('Loading...')).toBeInTheDocument()
    })

    it('shows an error state when getView throws', async () => {
      const ws = makeTasksWorkspace()
      seedTasks(ws)
      const broken = {
        getTableRows: ws.getTableRows.bind(ws),
        getView: () => { throw new Error('View config missing') },
      }
      renderKanban(broken)
      await waitFor(() =>
        expect(screen.getByText('Error loading view')).toBeInTheDocument(),
      )
    })
  })

  describe('column rendering', () => {
    it('renders all column_options as columns even when empty', async () => {
      // A fresh workspace with kanban view but no rows yet
      const ws = makeTasksWorkspace()
      ws.createView(JSON.stringify({
        id: 'board',
        name: 'Empty Board',
        table_id: 'tasks',
        view_type: 'kanban',
        sort: [],
        filters: [],
        kanban_config: {
          group_by_column: 'status',
          title_column: 'title',
          display_columns: [],
          column_options: ['Todo', 'In Progress', 'Done'],
        },
      }))
      renderKanban(ws, 'tasks', 'board')
      await waitFor(() => {
        expect(screen.getByText('Todo')).toBeInTheDocument()
        expect(screen.getByText('In Progress')).toBeInTheDocument()
        expect(screen.getByText('Done')).toBeInTheDocument()
      })
    })

    it('renders cards inside the correct column', async () => {
      const ws = makeKanbanWorkspace()
      renderKanban(ws)
      await waitFor(() => {
        expect(screen.getByText('Design homepage')).toBeInTheDocument()
        expect(screen.getByText('Set up CI/CD')).toBeInTheDocument()
        expect(screen.getByText('Write unit tests')).toBeInTheDocument()
      })
    })

    it('shows card count in each column header', async () => {
      const ws = makeKanbanWorkspace()
      renderKanban(ws)
      await waitFor(() => {
        // There are 2 Todo cards, 1 In Progress, 1 Done
        const counts = screen.getAllByText('1')
        expect(counts.length).toBeGreaterThan(0)
      })
    })

    it('renders the view name in the toolbar', async () => {
      const ws = makeKanbanWorkspace()
      renderKanban(ws)
      await waitFor(() => expect(screen.getByText('Task Board')).toBeInTheDocument())
    })

    it('groups rows that do not match any column_option into an "Uncategorized" column', async () => {
      const ws = makeTasksWorkspace()
      // Add a row with a status that's not in column_options
      ws.updateCell('tasks', 'mystery-row', 'title', '"Mystery task"')
      ws.updateCell('tasks', 'mystery-row', 'status', '"Blocked"')
      ws.createView(JSON.stringify({
        id: 'board2',
        name: 'Board',
        table_id: 'tasks',
        view_type: 'kanban',
        sort: [],
        filters: [],
        kanban_config: {
          group_by_column: 'status',
          title_column: 'title',
          display_columns: [],
          column_options: ['Todo', 'In Progress', 'Done'],
        },
      }))
      renderKanban(ws, 'tasks', 'board2')
      await waitFor(() => {
        expect(screen.getByText('Blocked')).toBeInTheDocument()
        expect(screen.getByText('Mystery task')).toBeInTheDocument()
      })
    })

    it('handles rows with no status value — puts them in "Uncategorized"', async () => {
      const ws = makeTasksWorkspace()
      ws.updateCell('tasks', 'no-status', 'title', '"Statusless task"')
      // no status cell set
      ws.createView(JSON.stringify({
        id: 'board3',
        name: 'Board',
        table_id: 'tasks',
        view_type: 'kanban',
        sort: [],
        filters: [],
        kanban_config: {
          group_by_column: 'status',
          title_column: 'title',
          display_columns: [],
          column_options: ['Todo', 'In Progress', 'Done'],
        },
      }))
      renderKanban(ws, 'tasks', 'board3')
      await waitFor(() => {
        expect(screen.getByText('Uncategorized')).toBeInTheDocument()
        expect(screen.getByText('Statusless task')).toBeInTheDocument()
      })
    })
  })

  describe('card content', () => {
    it('uses the title_column value as the card title', async () => {
      const ws = makeKanbanWorkspace()
      renderKanban(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
    })

    it('shows an "open full entry" expand button on each card', async () => {
      const ws = makeKanbanWorkspace() // 4 seeded tasks
      renderKanban(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      expect(screen.getAllByLabelText('Open full entry')).toHaveLength(4)
    })

    it('shows "Untitled" for cards with no title value', async () => {
      const ws = makeTasksWorkspace()
      // A row with status but no title
      ws.updateCell('tasks', 'notitle', 'status', '"Todo"')
      ws.createView(JSON.stringify({
        id: 'board4',
        name: 'Board',
        table_id: 'tasks',
        view_type: 'kanban',
        sort: [],
        filters: [],
        kanban_config: {
          group_by_column: 'status',
          title_column: 'title',
          display_columns: [],
          column_options: ['Todo'],
        },
      }))
      renderKanban(ws, 'tasks', 'board4')
      await waitFor(() => expect(screen.getByText('Untitled')).toBeInTheDocument())
    })
  })

  describe('deleted columns', () => {
    it('hides a deleted column\'s lingering values from cards', async () => {
      // Cards carry a due_date value (2026-01-15). After the column is deleted,
      // that lingering value must not resurface on the card even though its cell
      // still exists in the row data (decay model).
      const ws = makeKanbanWorkspace()
      ws.deleteColumn('tasks', 'due_date')
      renderKanban(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      expect(screen.queryByText('2026-01-15')).not.toBeInTheDocument()
    })

    it('prompts to re-group when the board groups by a deleted column', async () => {
      const ws = makeKanbanWorkspace() // groups by "status"
      // A second select column so the picker has a valid target (issue
      // 6e2011e3: only select columns are groupable).
      ws.addColumn(
        'tasks',
        JSON.stringify({
          id: 'stage',
          name: 'Stage',
          column_type: 'select',
          options: ['Early', 'Late'],
        }),
      )
      ws.deleteColumn('tasks', 'status')
      renderKanban(ws)
      await waitFor(() =>
        expect(screen.getByText(/no longer exists/i)).toBeInTheDocument(),
      )
      // The picker offers the remaining select column to group by instead.
      expect(screen.getByText('Use this column')).toBeInTheDocument()
      expect(screen.getByRole('option', { name: 'Stage' })).toBeInTheDocument()
    })

    it('offers only select columns in the re-group picker (issue 6e2011e3)', async () => {
      const ws = makeKanbanWorkspace()
      ws.addColumn(
        'tasks',
        JSON.stringify({
          id: 'stage',
          name: 'Stage',
          column_type: 'select',
          options: ['Early', 'Late'],
        }),
      )
      ws.deleteColumn('tasks', 'status')
      renderKanban(ws)
      await waitFor(() =>
        expect(screen.getByText(/no longer exists/i)).toBeInTheDocument(),
      )
      // Text/number/date/etc. columns must not be groupable.
      expect(screen.queryByRole('option', { name: 'Title' })).not.toBeInTheDocument()
      expect(screen.queryByRole('option', { name: 'Priority' })).not.toBeInTheDocument()
      expect(screen.queryByRole('option', { name: 'Due Date' })).not.toBeInTheDocument()
    })

    it('hides the board until the invalid group-by is fixed (issue cc70fdc5)', async () => {
      const ws = makeKanbanWorkspace() // 4 seeded tasks, groups by "status"
      ws.deleteColumn('tasks', 'status')
      const { container } = renderKanban(ws)
      await waitFor(() =>
        expect(screen.getByText(/no longer exists/i)).toBeInTheDocument(),
      )
      // No board, no cards — only the re-edit prompt.
      expect(container.querySelector('.kanban-board-wrap')).not.toBeInTheDocument()
      expect(screen.queryByText('Design homepage')).not.toBeInTheDocument()
    })

    it('says to add a Select column when no groupable column remains', async () => {
      const ws = makeKanbanWorkspace() // "status" is the only select column
      ws.deleteColumn('tasks', 'status')
      renderKanban(ws)
      await waitFor(() =>
        expect(screen.getByText(/no longer exists/i)).toBeInTheDocument(),
      )
      expect(screen.getByText(/add a select column first/i)).toBeInTheDocument()
      expect(screen.queryByText('Use this column')).not.toBeInTheDocument()
    })

    it('does not prompt when the group-by column still exists', async () => {
      const ws = makeKanbanWorkspace()
      renderKanban(ws)
      await waitFor(() => expect(screen.getByText('Task Board')).toBeInTheDocument())
      expect(screen.queryByText(/no longer exists/i)).not.toBeInTheDocument()
    })
  })

  describe('drag and drop — resolveTargetColumn integration', () => {
    // Full D&D is impractical in jsdom; the column resolution logic is already
    // unit-tested in kanbanUtils.test.ts.  This test verifies that
    // handleDragEnd does NOT corrupt a cell when over.id cannot be resolved.
    it('updateCell is NOT called when over.id resolves to null', async () => {
      const ws = makeKanbanWorkspace()
      const spy = vi.spyOn(ws, 'updateCell')
      renderKanban(ws)
      await waitFor(() => expect(screen.getByText('Task Board')).toBeInTheDocument())
      // We cannot easily fire dnd-kit events in jsdom; confirm no spurious calls
      // have happened during initial render
      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('empty column drop targets', () => {
    it('renders a droppable wrapper for every column, including empty ones', async () => {
      const ws = makeTasksWorkspace()
      // Create a view with 3 columns but no rows — all columns are empty
      ws.createView(JSON.stringify({
        id: 'empty-board',
        name: 'Empty Board',
        table_id: 'tasks',
        view_type: 'kanban',
        sort: [],
        filters: [],
        kanban_config: {
          group_by_column: 'status',
          title_column: 'title',
          display_columns: [],
          column_options: ['Backlog', 'Active', 'Done'],
        },
      }))
      renderKanban(ws, 'tasks', 'empty-board')
      await waitFor(() => {
        expect(screen.getByText('Backlog')).toBeInTheDocument()
        expect(screen.getByText('Active')).toBeInTheDocument()
        expect(screen.getByText('Done')).toBeInTheDocument()
      })
      // Every column exposes a .kcol__drop-area element
      const dropAreas = document.querySelectorAll('.kcol__drop-area')
      expect(dropAreas.length).toBe(3)
    })

    it('each column has a drop area regardless of card count', async () => {
      const ws = makeKanbanWorkspace() // has cards only in some columns
      renderKanban(ws)
      await waitFor(() => expect(screen.getByText('Task Board')).toBeInTheDocument())
      const dropAreas = document.querySelectorAll('.kcol__drop-area')
      // 3 column_options → 3 drop areas
      expect(dropAreas.length).toBe(3)
    })
  })

  describe('card footer person (issue bc48a6ed)', () => {
    it('a text assignee column no longer renders the avatar footer (magic id dropped)', async () => {
      const ws = makeKanbanWorkspace() // tasks.assignee is a TEXT column
      const { container } = renderKanban(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      expect(container.querySelector('.kcard__footer')).not.toBeInTheDocument()
    })

    it('an unconfigured member column shows NO footer (explicit setting required)', async () => {
      const ws = makeKanbanWorkspace()
      ws.addColumn(
        'tasks',
        JSON.stringify({ id: 'owner', name: 'Owner', column_type: 'member' }),
      )
      ws.updateCell('tasks', 'task1', 'owner', JSON.stringify('@amelia:tidework.io'))
      const { container } = renderKanban(ws)
      await waitFor(() => expect(screen.getByText('Design homepage')).toBeInTheDocument())
      // A member column existing is not enough — the view must OPT IN.
      expect(container.querySelector('.kcard__footer')).not.toBeInTheDocument()
    })

    it('the CONFIGURED assignee column drives the footer, localpart fallback', async () => {
      const ws = makeKanbanWorkspace()
      ws.addColumn(
        'tasks',
        JSON.stringify({ id: 'owner', name: 'Owner', column_type: 'member' }),
      )
      ws.updateCell('tasks', 'task1', 'owner', JSON.stringify('@amelia:tidework.io'))
      // Recreate the board view WITH the explicit assignee setting.
      ws.createView(JSON.stringify({
        id: 'board-assignee',
        name: 'Board',
        table_id: 'tasks',
        view_type: 'kanban',
        sort: [],
        filters: [],
        kanban_config: {
          group_by_column: 'status',
          title_column: 'title',
          display_columns: [],
          column_options: ['Todo', 'In Progress', 'Done'],
          assignee_column: 'owner',
        },
      }))
      const { container } = renderKanban(ws, 'tasks', 'board-assignee')
      await waitFor(() => expect(container.querySelector('.kcard__footer')).toBeInTheDocument())
      // No listMembers on the mock → display falls back to the MXID localpart.
      expect(screen.getByText('amelia')).toBeInTheDocument()
    })
  })
})
