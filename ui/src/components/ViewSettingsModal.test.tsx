import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ViewSettingsModal } from './ViewSettingsModal'

const SCHEMA = {
  id: 'tasks',
  name: 'Tasks',
  columns: {
    title: { id: 'title', name: 'Title', column_type: 'text' },
    status: { id: 'status', name: 'Status', column_type: 'select', options: ['Todo', 'Done'] },
    stage: { id: 'stage', name: 'Stage', column_type: 'select', options: ['Early', 'Late'] },
  },
}

const KANBAN_VIEW = {
  id: 'board1',
  name: 'Task Board',
  table_id: 'tasks',
  view_type: 'kanban',
  sort: [],
  filters: [],
  kanban_config: {
    group_by_column: 'status',
    title_column: 'title',
    display_columns: [],
    column_options: ['Todo', 'Done'],
  },
}

function makeWorkspace() {
  return {
    getTableSchema: vi.fn().mockReturnValue(JSON.stringify(SCHEMA)),
    createView: vi.fn().mockResolvedValue(undefined),
  }
}

function renderModal(ws = makeWorkspace(), viewConfig: any = KANBAN_VIEW, onSaved = vi.fn()) {
  render(
    <ViewSettingsModal
      workspace={ws}
      tableId="tasks"
      viewId={viewConfig.id}
      viewConfig={viewConfig}
      onSaved={onSaved}
      onClose={vi.fn()}
    />,
  )
  return { ws, onSaved }
}

describe('ViewSettingsModal', () => {
  it('prefills the current name and kanban config', () => {
    renderModal()
    expect(screen.getByDisplayValue('Task Board')).toBeInTheDocument()
    const groupSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement
    expect(groupSelect.value).toBe('status')
  })

  it('saves an upsert with the SAME view id and the new group-by config', async () => {
    const { ws, onSaved } = renderModal()
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'stage' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(ws.createView).toHaveBeenCalledTimes(1))
    const sent = JSON.parse(ws.createView.mock.calls[0][0])
    expect(sent.id).toBe('board1') // upsert, not a new view
    expect(sent.kanban_config.group_by_column).toBe('stage')
    // column_options track the new group-by column's schema options.
    expect(sent.kanban_config.column_options).toEqual(['Early', 'Late'])
    expect(onSaved).toHaveBeenCalled()
  })

  it('renames the view', async () => {
    const { ws } = renderModal()
    fireEvent.change(screen.getByDisplayValue('Task Board'), { target: { value: 'Sprint Board' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(ws.createView).toHaveBeenCalled())
    expect(JSON.parse(ws.createView.mock.calls[0][0]).name).toBe('Sprint Board')
  })

  it('disables save when the name is emptied', () => {
    renderModal()
    fireEvent.change(screen.getByDisplayValue('Task Board'), { target: { value: '' } })
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  it('shows no kanban fields for a table view', () => {
    renderModal(makeWorkspace(), {
      id: 'v1',
      name: 'Grid',
      table_id: 'tasks',
      view_type: 'table',
      sort: [],
      filters: [],
    })
    expect(screen.queryByText(/group by column/i)).not.toBeInTheDocument()
  })
})
