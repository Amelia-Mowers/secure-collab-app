import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  passkeyEnrolled: true,
  revealRecoveryKey: vi.fn(async () => 'SECRET-KEY-123'),
  regenerateRecoveryKey: vi.fn(async () => 'NEW-KEY-456'),
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    passkeyEnrolled: h.passkeyEnrolled,
    revealRecoveryKey: h.revealRecoveryKey,
    regenerateRecoveryKey: h.regenerateRecoveryKey,
  }),
}))

import { RecoveryKeyModal } from './RecoveryKeyModal'

describe('RecoveryKeyModal', () => {
  beforeEach(() => {
    h.passkeyEnrolled = true
    h.revealRecoveryKey = vi.fn(async () => 'SECRET-KEY-123')
    h.regenerateRecoveryKey = vi.fn(async () => 'NEW-KEY-456')
  })

  it('reveals the unlock key behind a passkey confirmation', async () => {
    render(<RecoveryKeyModal onClose={vi.fn()} />)
    // Not shown until the user explicitly reveals it.
    expect(screen.queryByText('SECRET-KEY-123')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /reveal key/i }))
    await waitFor(() => expect(screen.getByText('SECRET-KEY-123')).toBeInTheDocument())
    expect(h.revealRecoveryKey).toHaveBeenCalledTimes(1)
  })

  it('surfaces a reveal failure without leaving the dialog', async () => {
    h.revealRecoveryKey = vi.fn(async (): Promise<string> => {
      throw new Error('Passkey unlock was cancelled')
    })
    render(<RecoveryKeyModal onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /reveal key/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/cancelled/i))
    expect(screen.queryByText('SECRET-KEY-123')).not.toBeInTheDocument()
  })

  it('explains there is nothing to re-display for a saved-recovery-key account', () => {
    h.passkeyEnrolled = false
    render(<RecoveryKeyModal onClose={vi.fn()} />)
    expect(screen.getByText(/saved when you signed up/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reveal key/i })).toBeNull()
    expect(h.revealRecoveryKey).not.toHaveBeenCalled()
  })

  describe('manual recovery-key account: regenerate', () => {
    beforeEach(() => {
      h.passkeyEnrolled = false
    })

    it('rotates to a new key behind a destructive-action confirmation', async () => {
      render(<RecoveryKeyModal onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /generate a new recovery key/i }))
      // The confirmation spells out the consequence; nothing rotates yet.
      expect(screen.getByText(/stops working immediately/i)).toBeInTheDocument()
      expect(h.regenerateRecoveryKey).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: /generate new key/i }))
      await waitFor(() => expect(screen.getByText('NEW-KEY-456')).toBeInTheDocument())
      expect(h.regenerateRecoveryKey).toHaveBeenCalledTimes(1)
    })

    it('can back out of the confirmation without rotating', () => {
      render(<RecoveryKeyModal onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /generate a new recovery key/i }))
      fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
      expect(screen.getByText(/saved when you signed up/i)).toBeInTheDocument()
      expect(h.regenerateRecoveryKey).not.toHaveBeenCalled()
    })

    it('surfaces a regenerate failure without leaving the dialog', async () => {
      h.regenerateRecoveryKey = vi.fn(async (): Promise<string> => {
        throw new Error('Backup upload failed')
      })
      render(<RecoveryKeyModal onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /generate a new recovery key/i }))
      fireEvent.click(screen.getByRole('button', { name: /generate new key/i }))
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/upload failed/i))
      expect(screen.queryByText('NEW-KEY-456')).not.toBeInTheDocument()
    })
  })

  it('closes via Cancel before revealing', () => {
    const onClose = vi.fn()
    render(<RecoveryKeyModal onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes via Done after revealing', async () => {
    const onClose = vi.fn()
    render(<RecoveryKeyModal onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /reveal key/i }))
    await waitFor(() => screen.getByText('SECRET-KEY-123'))
    fireEvent.click(screen.getByRole('button', { name: /done/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
