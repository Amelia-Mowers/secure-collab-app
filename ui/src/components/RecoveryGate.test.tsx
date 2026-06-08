import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Mock the auth hook so we can drive recoveryPrompt directly.
const h = vi.hoisted(() => ({
  prompt: null as null | { kind: 'save'; recoveryKey: string } | { kind: 'enter' },
  submit: vi.fn(),
  dismiss: vi.fn(),
}))

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    recoveryPrompt: h.prompt,
    submitRecoveryKey: h.submit,
    dismissRecoveryPrompt: h.dismiss,
  }),
}))

import { RecoveryGate } from './RecoveryGate'

describe('RecoveryGate', () => {
  beforeEach(() => {
    h.prompt = null
    h.submit.mockReset()
    h.dismiss.mockReset()
  })

  it('renders nothing when there is no prompt', () => {
    const { container } = render(<RecoveryGate />)
    expect(container).toBeEmptyDOMElement()
  })

  describe('save (first-device bootstrap)', () => {
    beforeEach(() => {
      h.prompt = { kind: 'save', recoveryKey: 'ABCD-EFGH-IJKL' }
    })

    it('shows the recovery key to save', () => {
      render(<RecoveryGate />)
      expect(screen.getByText('ABCD-EFGH-IJKL')).toBeInTheDocument()
      expect(screen.getByRole('heading').textContent).toMatch(/save your recovery key/i)
    })

    it('dismisses once the user confirms they saved it', () => {
      render(<RecoveryGate />)
      fireEvent.click(screen.getByRole('button', { name: /saved it/i }))
      expect(h.dismiss).toHaveBeenCalledTimes(1)
    })
  })

  describe('enter (returning-device restore)', () => {
    beforeEach(() => {
      h.prompt = { kind: 'enter' }
    })

    it('disables Restore until a key is entered', () => {
      render(<RecoveryGate />)
      expect(screen.getByRole('button', { name: /^restore$/i })).toBeDisabled()
    })

    it('submits the trimmed recovery key', async () => {
      h.submit.mockResolvedValue(undefined)
      render(<RecoveryGate />)
      fireEvent.change(screen.getByPlaceholderText(/recovery key/i), {
        target: { value: '  my-key  ' },
      })
      fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
      await waitFor(() => expect(h.submit).toHaveBeenCalledWith('my-key'))
    })

    it('shows an error when restore fails', async () => {
      h.submit.mockRejectedValue(new Error('Invalid recovery key'))
      render(<RecoveryGate />)
      fireEvent.change(screen.getByPlaceholderText(/recovery key/i), {
        target: { value: 'bad' },
      })
      fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toMatch(/invalid recovery key/i),
      )
    })

    it('lets the user explicitly continue without history', () => {
      render(<RecoveryGate />)
      fireEvent.click(screen.getByRole('button', { name: /continue without history/i }))
      expect(h.dismiss).toHaveBeenCalledTimes(1)
    })
  })
})
