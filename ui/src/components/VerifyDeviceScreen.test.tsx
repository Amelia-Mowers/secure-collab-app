import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  recoveryPrompt: null as any,
  verification: null as any,
  passkeyAvailable: false,
  passkeyEnrolled: false,
  submitRecoveryKey: vi.fn(),
  dismissRecoveryPrompt: vi.fn(),
  retryRecoverySetup: vi.fn(async () => undefined),
  setupPasskeyRecovery: vi.fn(async () => undefined),
  setupKeyRecovery: vi.fn(async () => undefined),
  unlockWithPasskey: vi.fn(async () => undefined),
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
    passkeyAvailable: h.passkeyAvailable,
    passkeyEnrolled: h.passkeyEnrolled,
    submitRecoveryKey: h.submitRecoveryKey,
    dismissRecoveryPrompt: h.dismissRecoveryPrompt,
    retryRecoverySetup: h.retryRecoverySetup,
    setupPasskeyRecovery: h.setupPasskeyRecovery,
    setupKeyRecovery: h.setupKeyRecovery,
    unlockWithPasskey: h.unlockWithPasskey,
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
    h.passkeyAvailable = false
    h.passkeyEnrolled = false
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

  it('frames the key as a backup when recovery was set up via passkey', () => {
    h.recoveryPrompt = { kind: 'save', recoveryKey: 'BACKUP-KEY', viaPasskey: true }
    render(<VerifyDeviceScreen />)
    expect(screen.getByRole('heading', { name: /backup key/i })).toBeInTheDocument()
    expect(screen.getByText('BACKUP-KEY')).toBeInTheDocument()
  })

  describe('choose recovery method (first device, passkey-capable)', () => {
    beforeEach(() => {
      h.recoveryPrompt = { kind: 'setup' }
    })

    it('offers both the passkey and recovery-key paths', () => {
      render(<VerifyDeviceScreen />)
      expect(screen.getByRole('button', { name: /set up a passkey/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /recovery key instead/i })).toBeInTheDocument()
    })

    it('sets up a passkey', async () => {
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /set up a passkey/i }))
      await waitFor(() => expect(h.setupPasskeyRecovery).toHaveBeenCalledTimes(1))
    })

    it('falls back to a recovery key', async () => {
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /recovery key instead/i }))
      await waitFor(() => expect(h.setupKeyRecovery).toHaveBeenCalledTimes(1))
    })
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

    it('offers passkey unlock when the browser supports it AND the account is enrolled', async () => {
      h.passkeyAvailable = true
      h.passkeyEnrolled = true
      h.unlockWithPasskey.mockResolvedValue(undefined)
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /unlock with passkey/i }))
      await waitFor(() => expect(h.unlockWithPasskey).toHaveBeenCalledTimes(1))
    })

    it('hides passkey unlock when the browser lacks passkey support', () => {
      h.passkeyEnrolled = true // enrolled, but the browser has no authenticator
      render(<VerifyDeviceScreen />) // passkeyAvailable false
      expect(screen.queryByRole('button', { name: /unlock with passkey/i })).toBeNull()
    })

    it('hides passkey unlock for a legacy account (authenticator present but no passkey enrolled)', () => {
      h.passkeyAvailable = true
      h.passkeyEnrolled = false // raw-recovery-key account — no passkey to use
      render(<VerifyDeviceScreen />)
      expect(screen.queryByRole('button', { name: /unlock with passkey/i })).toBeNull()
      // The non-passkey paths are still offered.
      expect(
        screen.getByRole('button', { name: /verify with another device/i }),
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /use your master key/i })).toBeInTheDocument()
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
