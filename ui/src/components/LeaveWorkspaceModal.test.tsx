import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LeaveWorkspaceModal } from './LeaveWorkspaceModal'
import type { WorkspaceMember } from '@/lib/roles'

const ME = '@me:tidework.io'
const BOB = '@bob:tidework.io'
const CAROL = '@carol:tidework.io'

const member = (id: string, role: WorkspaceMember['role']): WorkspaceMember => ({
  id,
  name: id.slice(1).split(':')[0],
  role,
})

function renderModal(over: Partial<Parameters<typeof LeaveWorkspaceModal>[0]> = {}) {
  const props = {
    workspaceName: 'Acme',
    members: [member(ME, 'admin'), member(BOB, 'editor')],
    myUserId: ME,
    myRole: 'admin' as const,
    onLeave: vi.fn().mockResolvedValue(undefined),
    onPromote: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...over,
  }
  render(<LeaveWorkspaceModal {...props} />)
  return props
}

describe('LeaveWorkspaceModal', () => {
  it('leaves without removing anyone by default', async () => {
    const props = renderModal({ members: [member(ME, 'editor'), member(BOB, 'admin')], myRole: 'editor' })
    fireEvent.click(screen.getByText('Leave workspace'))
    await waitFor(() => expect(props.onLeave).toHaveBeenCalledWith(false))
    expect(props.onPromote).not.toHaveBeenCalled()
  })

  it('blocks the last admin from leaving until a successor is chosen', async () => {
    const props = renderModal() // ME is the only admin, BOB remains
    expect(screen.getByText(/only admin/i)).toBeInTheDocument()
    const confirm = screen.getByText('Leave workspace')
    expect(confirm).toBeDisabled()

    fireEvent.change(screen.getByLabelText('New admin'), { target: { value: BOB } })
    expect(confirm).not.toBeDisabled()
    fireEvent.click(confirm)
    // Promotion lands BEFORE the leave, or the workspace is stranded.
    await waitFor(() => expect(props.onPromote).toHaveBeenCalledWith(BOB))
    await waitFor(() => expect(props.onLeave).toHaveBeenCalledWith(false))
  })

  it('does not ask for a successor when another admin remains', () => {
    renderModal({ members: [member(ME, 'admin'), member(CAROL, 'admin')] })
    expect(screen.queryByText(/only admin/i)).not.toBeInTheDocument()
    expect(screen.getByText('Leave workspace')).not.toBeDisabled()
  })

  it('lets the last member leave with no successor, and says the data is cleared', async () => {
    const props = renderModal({ members: [member(ME, 'admin')] })
    expect(screen.queryByText(/only admin/i)).not.toBeInTheDocument()
    expect(screen.getByText(/last member/i)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Leave workspace'))
    await waitFor(() => expect(props.onLeave).toHaveBeenCalledWith(false))
    expect(props.onPromote).not.toHaveBeenCalled()
  })

  it('the delete toggle removes everyone and needs no successor', async () => {
    const props = renderModal() // last admin, BOB remains
    fireEvent.click(screen.getByRole('checkbox'))
    // Deleting removes everyone, so there is nobody to hand over to.
    expect(screen.queryByText(/only admin/i)).not.toBeInTheDocument()
    expect(screen.getByText(/can't be undone|can’t be undone/i)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Delete workspace'))
    await waitFor(() => expect(props.onLeave).toHaveBeenCalledWith(true))
    expect(props.onPromote).not.toHaveBeenCalled()
  })

  it('offers the delete toggle only to admins', () => {
    renderModal({ myRole: 'editor' })
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('surfaces a failure and stays open', async () => {
    const onLeave = vi.fn().mockRejectedValue(new Error('Server said no'))
    const props = renderModal({
      members: [member(ME, 'editor'), member(BOB, 'admin')],
      myRole: 'editor',
      onLeave,
    })
    fireEvent.click(screen.getByText('Leave workspace'))
    await waitFor(() => expect(screen.getByText('Server said no')).toBeInTheDocument())
    expect(props.onClose).not.toHaveBeenCalled()
  })
})
