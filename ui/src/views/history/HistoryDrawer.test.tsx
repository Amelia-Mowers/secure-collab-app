import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { HistoryDrawer } from './HistoryDrawer'
import type { WorkspaceHandle } from '../../hooks/useTable'

const EDIT = {
  kind: 'edit',
  tableId: 'tbl1',
  rowId: 'row1',
  columnId: 'status',
  value: 'closed',
  prevValue: 'open',
  sender: '@alice:tidework.io',
  serverTs: 1_752_000_000_000,
}

const REVERT = {
  kind: 'revert',
  id: 'rev1',
  actor: '@bob:tidework.io',
  target: 1_751_000_000_000,
  scope: 'tbl1',
  label: null,
  serverTs: 1_753_000_000_000,
}

function makeWorkspace(overrides: Partial<WorkspaceHandle> = {}): WorkspaceHandle {
  return {
    getChangeLog: vi.fn().mockResolvedValue(JSON.stringify([REVERT, EDIT])),
    rollbackTo: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as WorkspaceHandle
}

function renderDrawer(workspace: WorkspaceHandle, onReverted = vi.fn(), onClose = vi.fn()) {
  render(
    <HistoryDrawer workspace={workspace} tableId="tbl1" onClose={onClose} onReverted={onReverted} />,
  )
  return { onReverted, onClose }
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('HistoryDrawer', () => {
  it('explains history is unavailable when the workspace has no change log', async () => {
    renderDrawer({} as WorkspaceHandle)
    expect(
      await screen.findByText('History is only available for synced workspaces.'),
    ).toBeInTheDocument()
  })

  it('renders edits with who, column, and old → new values', async () => {
    const ws = makeWorkspace()
    renderDrawer(ws)
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.getByText('status')).toBeInTheDocument()
    expect(screen.getByText('open')).toBeInTheDocument()
    expect(screen.getByText('closed')).toBeInTheDocument()
    expect(ws.getChangeLog).toHaveBeenCalledWith('tbl1')
  })

  it('renders revert entries with a badge and the actor', async () => {
    renderDrawer(makeWorkspace())
    expect(await screen.findByText('↩ reverted')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
  })

  it('shows an empty state when there are no entries', async () => {
    renderDrawer(makeWorkspace({ getChangeLog: vi.fn().mockResolvedValue('[]') }))
    expect(await screen.findByText('No changes recorded yet.')).toBeInTheDocument()
  })

  it('surfaces load failures as an error', async () => {
    renderDrawer(
      makeWorkspace({ getChangeLog: vi.fn().mockRejectedValue(new Error('timeline gather failed')) }),
    )
    expect(await screen.findByText('timeline gather failed')).toBeInTheDocument()
  })

  it('restores after confirmation and notifies the parent', async () => {
    const ws = makeWorkspace()
    const { onReverted } = renderDrawer(ws)
    fireEvent.click((await screen.findAllByText('Restore'))[1])
    await waitFor(() => expect(ws.rollbackTo).toHaveBeenCalledWith('tbl1', EDIT.serverTs))
    expect(await screen.findByText('Reverted.')).toBeInTheDocument()
    expect(onReverted).toHaveBeenCalled()
  })

  it('does not restore when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const ws = makeWorkspace()
    const { onReverted } = renderDrawer(ws)
    fireEvent.click((await screen.findAllByText('Restore'))[0])
    expect(ws.rollbackTo).not.toHaveBeenCalled()
    expect(onReverted).not.toHaveBeenCalled()
  })

  it('says so when the table is already at the target state (0 updates)', async () => {
    const ws = makeWorkspace({ rollbackTo: vi.fn().mockResolvedValue(0) })
    renderDrawer(ws)
    fireEvent.click((await screen.findAllByText('Restore'))[0])
    expect(
      await screen.findByText('Already at that state — nothing to change.'),
    ).toBeInTheDocument()
  })

  it('closes from the header button and the scrim', async () => {
    const onClose = vi.fn()
    render(
      <HistoryDrawer workspace={makeWorkspace()} tableId="tbl1" onClose={onClose} />,
    )
    await screen.findByText('alice')
    fireEvent.click(screen.getByLabelText('Close history'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
