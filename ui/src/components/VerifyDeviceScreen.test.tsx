import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  recoveryPrompt: null as any,
  verification: null as any,
  submitRecoveryKey: vi.fn(),
  dismissRecoveryPrompt: vi.fn(),
  retryRecoverySetup: vi.fn(async () => undefined),
  signOut: vi.fn(),
  startVerification: vi.fn(),
  acceptIncomingVerification: vi.fn(),
  confirmVerification: vi.fn(),
  cancelVerification: vi.fn(),
}))

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({
    recoveryPrompt: h.recoveryPrompt,
    verification: h.verification,
    submitRecoveryKey: h.submitRecoveryKey,
    dismissRecoveryPrompt: h.dismissRecoveryPrompt,
    retryRecoverySetup: h.retryRecoverySetup,
    signOut: h.signOut,
    startVerification: h.startVerification,
    acceptIncomingVerification: h.acceptIncomingVerification,
    confirmVerification: h.confirmVerification,
    cancelVerification: h.cancelVerification,
  }),
}))

import { VerifyDeviceScreen } from './VerifyDeviceScreen'

describe('VerifyDeviceScreen', () => {
  beforeEach(() => {
    h.recoveryPrompt = null
    h.verification = null
    Object.values(h).forEach(v => typeof v === 'function' && (v as any).mockReset?.())
  })

  it('renders nothing when idle', () => {
    const { container } = render(<VerifyDeviceScreen />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the master key to save (first device)', () => {
    h.recoveryPrompt = { kind: 'save', recoveryKey: 'ABCD-EFGH-IJKL' }
    render(<VerifyDeviceScreen />)
    expect(screen.getByText('ABCD-EFGH-IJKL')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /saved it/i }))
    expect(h.dismissRecoveryPrompt).toHaveBeenCalledTimes(1)
  })

  describe('recovery setup failed (blocking, never silent)', () => {
    beforeEach(() => {
      h.recoveryPrompt = { kind: 'error', message: 'Backup upload failed' }
    })

    it('blocks with the failure and its consequence spelled out', () => {
      render(<VerifyDeviceScreen />)
      expect(screen.getByRole('heading', { name: /couldn.t set up recovery/i })).toBeInTheDocument()
      expect(screen.getByRole('alert')).toHaveTextContent('Backup upload failed')
      // No dismiss affordance — only retry or sign out.
      expect(screen.queryByRole('button', { name: /saved it|dismiss|close/i })).toBeNull()
    })

    it('retries the bootstrap', async () => {
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /^retry$/i }))
      await waitFor(() => expect(h.retryRecoverySetup).toHaveBeenCalledTimes(1))
    })

    it('offers sign-out as the way out', () => {
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
      expect(h.signOut).toHaveBeenCalledTimes(1)
    })
  })

  describe('verify gate (new device)', () => {
    beforeEach(() => {
      h.recoveryPrompt = { kind: 'verify' }
    })

    it('offers SAS and master key — and has NO bypass', () => {
      render(<VerifyDeviceScreen />)
      expect(
        screen.getByRole('button', { name: /verify with another device/i }),
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /use your master key/i })).toBeInTheDocument()
      // No "continue without history" / skip escape hatch.
      expect(screen.queryByText(/continue without/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/skip/i)).not.toBeInTheDocument()
    })

    it('starts SAS verification', async () => {
      h.startVerification.mockResolvedValue(undefined)
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /verify with another device/i }))
      await waitFor(() => expect(h.startVerification).toHaveBeenCalledTimes(1))
    })

    it('restores with the trimmed master key', async () => {
      h.submitRecoveryKey.mockResolvedValue(undefined)
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /use your master key/i }))
      fireEvent.change(screen.getByPlaceholderText(/master key/i), { target: { value: '  k  ' } })
      fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
      await waitFor(() => expect(h.submitRecoveryKey).toHaveBeenCalledWith('k'))
    })
  })

  describe('active verification', () => {
    it('shows the emoji and confirms a match', () => {
      h.verification = {
        role: 'self',
        status: 'emoji',
        emoji: [
          { symbol: '🐶', description: 'Dog' },
          { symbol: '🐱', description: 'Cat' },
        ],
      }
      render(<VerifyDeviceScreen />)
      expect(screen.getByText('🐶')).toBeInTheDocument()
      expect(screen.getByText('Cat')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /they match/i }))
      expect(h.confirmVerification).toHaveBeenCalledTimes(1)
    })

    it('cancels on emoji mismatch', () => {
      h.verification = { role: 'self', status: 'emoji', emoji: [{ symbol: '🐶', description: 'Dog' }] }
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /they don.t match/i }))
      expect(h.cancelVerification).toHaveBeenCalledTimes(1)
    })

    it('accepts an incoming request', () => {
      h.verification = { role: 'incoming', status: 'pending', emoji: [] }
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /^verify$/i }))
      expect(h.acceptIncomingVerification).toHaveBeenCalledTimes(1)
    })

    it('shows a waiting state while pending (self)', () => {
      h.verification = { role: 'self', status: 'pending', emoji: [] }
      render(<VerifyDeviceScreen />)
      expect(screen.getByText(/verifying/i)).toBeInTheDocument()
    })
  })
})
