import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ShareModal } from './Sidebar'

/**
 * Who is offered an invite link.
 *
 * Minting one writes room state, which the homeserver refuses below admin — so
 * offering the button to everyone would mean a control that exists, looks
 * usable, and fails only when clicked. The e2e covers the admin half against a
 * real server; the refusal is cheaper to pin here.
 */
function workspaceWith(overrides: Record<string, unknown> = {}) {
  return {
    inviteUser: vi.fn(),
    createInviteLink: vi.fn(),
    ...overrides,
  }
}

describe('ShareModal invite links', () => {
  it('offers a link to someone who can manage the workspace', () => {
    render(<ShareModal workspace={workspaceWith()} onClose={() => {}} canManage />)
    expect(screen.getByRole('button', { name: 'Create invite link' })).toBeInTheDocument()
  })

  it('offers no link to someone who cannot', () => {
    render(<ShareModal workspace={workspaceWith()} onClose={() => {}} canManage={false} />)
    expect(screen.queryByRole('button', { name: 'Create invite link' })).not.toBeInTheDocument()
  })

  it('offers no link when the build has no binding for it', () => {
    // Feature-detected like every other bridge call: a workspace without the
    // method renders nothing rather than throwing on click.
    render(
      <ShareModal
        workspace={workspaceWith({ createInviteLink: undefined })}
        onClose={() => {}}
        canManage
      />,
    )
    expect(screen.queryByRole('button', { name: 'Create invite link' })).not.toBeInTheDocument()
  })

  it('keeps the Matrix ID path available to everyone', () => {
    // It is the only way to invite someone on another homeserver, so it must
    // not disappear with the link control.
    render(<ShareModal workspace={workspaceWith()} onClose={() => {}} canManage={false} />)
    expect(screen.getByPlaceholderText('@user:server')).toBeInTheDocument()
  })
})
