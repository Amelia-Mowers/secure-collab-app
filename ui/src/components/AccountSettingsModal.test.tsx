import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  deleteAccount: vi.fn(async () => undefined),
  setDisplayName: vi.fn(async (_name: string) => undefined),
  getDisplayName: vi.fn(async () => 'Ada L'),
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    username: 'ada',
    userId: '@ada:tidework.io',
    matrixSession: {
      getDisplayName: h.getDisplayName,
      setDisplayName: h.setDisplayName,
    },
    deleteAccount: h.deleteAccount,
    openBillingPortal: vi.fn(async () => undefined),
    // RecoveryKeyModal is not opened in these tests, but it reads from useAuth.
    revealRecoveryKey: vi.fn(async () => 'KEY'),
    regenerateRecoveryKey: vi.fn(async () => 'KEY'),
    revealLegacyKey: vi.fn(async () => 'KEY'),
    markKeySaved: vi.fn(),
    passkeyAvailable: false,
    passkeyEnrolled: false,
  }),
}))

import { AccountSettingsModal } from './AccountSettingsModal'

const deleteButton = () => screen.getByRole('button', { name: /^delete account$/i })

describe('AccountSettingsModal', () => {
  beforeEach(() => {
    h.deleteAccount = vi.fn(async () => undefined)
    h.setDisplayName = vi.fn(async (_name: string) => undefined)
    h.getDisplayName = vi.fn(async () => 'Ada L')
  })

  it('prefills the display name from the server, not the localpart', async () => {
    render(<AccountSettingsModal onClose={() => {}} />)
    await waitFor(() =>
      expect(screen.getByLabelText(/display name/i)).toHaveValue('Ada L'),
    )
  })

  it('saves a new display name', async () => {
    render(<AccountSettingsModal onClose={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText(/display name/i)).toHaveValue('Ada L'))
    fireEvent.change(screen.getByLabelText(/display name/i), {
      target: { value: 'Ada Lovelace' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(h.setDisplayName).toHaveBeenCalledWith('Ada Lovelace'))
    expect(await screen.findByText(/saved\./i)).toBeInTheDocument()
  })

  // The guard that matters: deletion cancels billing and erases the account, so
  // it must be impossible to trigger by clicking around.
  it('keeps delete disabled until the username is typed exactly', async () => {
    render(<AccountSettingsModal onClose={() => {}} />)
    await screen.findByDisplayValue('Ada L') // let the name prefill settle
    expect(deleteButton()).toBeDisabled()

    const confirm = screen.getByLabelText(/type .* to confirm/i)
    fireEvent.change(confirm, { target: { value: 'ad' } })
    expect(deleteButton()).toBeDisabled()

    fireEvent.change(confirm, { target: { value: 'Ada' } })
    expect(deleteButton()).toBeDisabled() // case-sensitive

    fireEvent.change(confirm, { target: { value: 'ada' } })
    expect(deleteButton()).toBeEnabled()
  })

  it('does not call deleteAccount while the confirmation is wrong', async () => {
    render(<AccountSettingsModal onClose={() => {}} />)
    await screen.findByDisplayValue('Ada L')
    fireEvent.click(deleteButton())
    expect(h.deleteAccount).not.toHaveBeenCalled()
  })

  it('deletes once confirmed', async () => {
    render(<AccountSettingsModal onClose={() => {}} />)
    await screen.findByDisplayValue('Ada L')
    fireEvent.change(screen.getByLabelText(/type .* to confirm/i), {
      target: { value: 'ada' },
    })
    fireEvent.click(deleteButton())
    await waitFor(() => expect(h.deleteAccount).toHaveBeenCalledTimes(1))
  })

  it('surfaces a failed deletion and stays usable for a retry', async () => {
    h.deleteAccount = vi.fn(async (): Promise<undefined> => {
      throw new Error('Your subscription was cancelled, but the account could not be deleted.')
    })
    render(<AccountSettingsModal onClose={() => {}} />)
    await screen.findByDisplayValue('Ada L')
    fireEvent.change(screen.getByLabelText(/type .* to confirm/i), {
      target: { value: 'ada' },
    })
    fireEvent.click(deleteButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be deleted/i)
    // Re-enabled, not stuck on "Deleting…" — the whole point of restoring state
    // on failure is that the user can try again.
    await waitFor(() => expect(deleteButton()).toBeEnabled())
  })
})
