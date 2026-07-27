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
  addPasskeySpeedup: vi.fn(async () => undefined),
  confirmKeySaved: vi.fn(),
  revealLegacyKey: vi.fn(async () => 'LEGACY-KEY-1234'),
  markKeySaved: vi.fn(),
  unlockWithPasskey: vi.fn(async () => undefined),
  unlockSessionWithPasskey: vi.fn(async () => undefined),
  submitUnlockKey: vi.fn(async () => undefined),
  openBillingPortal: vi.fn(async () => undefined),
  signOut: vi.fn(),
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
    addPasskeySpeedup: h.addPasskeySpeedup,
    confirmKeySaved: h.confirmKeySaved,
    revealLegacyKey: h.revealLegacyKey,
    markKeySaved: h.markKeySaved,
    unlockWithPasskey: h.unlockWithPasskey,
    unlockSessionWithPasskey: h.unlockSessionWithPasskey,
    submitUnlockKey: h.submitUnlockKey,
    openBillingPortal: h.openBillingPortal,
    signOut: h.signOut,
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

  describe('save the recovery key (every first device)', () => {
    beforeEach(() => {
      h.recoveryPrompt = { kind: 'save', recoveryKey: 'ABCD-EFGH-IJKL' }
    })

    it('always shows the key — there is no passkey-first path that hides it', () => {
      render(<VerifyDeviceScreen />)
      expect(screen.getByText('ABCD-EFGH-IJKL')).toBeInTheDocument()
    })

    it('states plainly that losing the key loses the data permanently', () => {
      render(<VerifyDeviceScreen />)
      expect(screen.getByText(/gone permanently/i)).toBeInTheDocument()
    })

    it('tells the user where to put it', () => {
      render(<VerifyDeviceScreen />)
      expect(screen.getByText(/password manager/i)).toBeInTheDocument()
    })

    it('will not continue until the user acknowledges saving it', () => {
      // The cost of clicking past this screen is unbounded and unrecoverable,
      // so it takes a deliberate act rather than a reflex.
      render(<VerifyDeviceScreen />)
      const cont = screen.getByRole('button', { name: /continue/i })
      expect(cont).toBeDisabled()
      fireEvent.click(cont)
      expect(h.confirmKeySaved).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('checkbox'))
      expect(cont).toBeEnabled()
      fireEvent.click(cont)
      expect(h.confirmKeySaved).toHaveBeenCalledWith('ABCD-EFGH-IJKL')
    })
  })

  describe('offer a passkey as a speed-up (after the key is saved)', () => {
    beforeEach(() => {
      h.recoveryPrompt = { kind: 'speedup', recoveryKey: 'ABCD-EFGH-IJKL' }
    })

    it('presents the passkey as optional and additive, not a replacement', () => {
      render(<VerifyDeviceScreen />)
      expect(screen.getByText(/does not replace the key/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /not now/i })).toBeInTheDocument()
    })

    it('warns about PRF-less providers before the user picks one', () => {
      render(<VerifyDeviceScreen />)
      expect(screen.getByText(/Bitwarden/)).toBeInTheDocument()
    })

    it('enrols the passkey against the saved key', async () => {
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /set up a passkey/i }))
      await waitFor(() => expect(h.addPasskeySpeedup).toHaveBeenCalledWith('ABCD-EFGH-IJKL'))
    })

    it('skipping proceeds without a passkey', () => {
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /not now/i }))
      expect(h.dismissRecoveryPrompt).toHaveBeenCalledTimes(1)
    })

    it('a PRF-less provider is reported as harmless, not as a failure', async () => {
      // The whole reason for wrapping rather than re-keying: nothing about the
      // account changed, so the copy must not imply damage.
      h.addPasskeySpeedup.mockRejectedValueOnce(new Error('Provider cannot do PRF'))
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /set up a passkey/i }))

      await waitFor(() => expect(screen.getByText(/Nothing has changed/i)).toBeInTheDocument())
      expect(screen.getByText(/Provider cannot do PRF/)).toBeInTheDocument()
      // …and there is still a way forward.
      expect(
        screen.getByRole('button', { name: /continue without a passkey/i }),
      ).toBeInTheDocument()
    })

    it('confirms success and reminds the user the key still works', async () => {
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /set up a passkey/i }))
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: /passkey ready/i })).toBeInTheDocument(),
      )
      expect(screen.getByText(/recovery key still works/i)).toBeInTheDocument()
    })
  })

  describe('legacy passkey account: save the key it never showed you', () => {
    beforeEach(() => {
      h.recoveryPrompt = { kind: 'save-legacy-key' }
      // The shared beforeEach mockReset()s every fn, which drops the default
      // implementation, so re-arm the one whose RETURN value matters here.
      h.revealLegacyKey.mockResolvedValue('LEGACY-KEY-1234')
    })

    it('explains why the account is at risk', () => {
      render(<VerifyDeviceScreen />)
      expect(screen.getByText(/only way in/i)).toBeInTheDocument()
    })

    it('offers no way to skip — the user cannot know the risk without being shown', () => {
      render(<VerifyDeviceScreen />)
      expect(screen.queryByRole('button', { name: /not now|skip|later/i })).not.toBeInTheDocument()
    })

    it('reveals the key via the passkey, then requires acknowledgement', async () => {
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /reveal my recovery key/i }))

      await waitFor(() => expect(screen.getByText('LEGACY-KEY-1234')).toBeInTheDocument())
      const cont = screen.getByRole('button', { name: /continue/i })
      expect(cont).toBeDisabled()

      fireEvent.click(screen.getByRole('checkbox'))
      fireEvent.click(cont)
      expect(h.markKeySaved).toHaveBeenCalledTimes(1)
      expect(h.dismissRecoveryPrompt).toHaveBeenCalledTimes(1)
    })

    it('surfaces a failed reveal without leaving the screen', async () => {
      h.revealLegacyKey.mockRejectedValueOnce(new Error('Passkey unlock was cancelled'))
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /reveal my recovery key/i }))

      await waitFor(() =>
        expect(screen.getByText(/Passkey unlock was cancelled/)).toBeInTheDocument(),
      )
      expect(screen.getByRole('button', { name: /reveal my recovery key/i })).toBeInTheDocument()
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

    it('shows the master-key path with no SAS and no bypass', () => {
      // Default: no passkey available → straight to the master-key field.
      render(<VerifyDeviceScreen />)
      expect(screen.getByPlaceholderText(/master key/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^restore$/i })).toBeInTheDocument()
      // The between-device (SAS) path is gone — and still no skip/continue bypass.
      expect(screen.queryByRole('button', { name: /verify with another device/i })).toBeNull()
      expect(screen.queryByText(/continue without/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/skip/i)).not.toBeInTheDocument()
    })

    it('offers passkey unlock — and no SAS — when supported AND enrolled', async () => {
      h.passkeyAvailable = true
      h.passkeyEnrolled = true
      h.unlockWithPasskey.mockResolvedValue(undefined)
      render(<VerifyDeviceScreen />)
      expect(screen.queryByRole('button', { name: /verify with another device/i })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /unlock with passkey/i }))
      await waitFor(() => expect(h.unlockWithPasskey).toHaveBeenCalledTimes(1))
    })

    it('hides passkey unlock when the browser lacks passkey support', () => {
      h.passkeyEnrolled = true // enrolled, but the browser has no authenticator
      render(<VerifyDeviceScreen />) // passkeyAvailable false
      expect(screen.queryByRole('button', { name: /unlock with passkey/i })).toBeNull()
      // Falls back to the master-key field.
      expect(screen.getByPlaceholderText(/master key/i)).toBeInTheDocument()
    })

    it('hides passkey unlock for a legacy account (authenticator present, no passkey enrolled)', () => {
      h.passkeyAvailable = true
      h.passkeyEnrolled = false // raw-recovery-key account — no passkey to use
      render(<VerifyDeviceScreen />)
      expect(screen.queryByRole('button', { name: /unlock with passkey/i })).toBeNull()
      expect(screen.queryByRole('button', { name: /verify with another device/i })).toBeNull()
      // The master-key field is the way in.
      expect(screen.getByPlaceholderText(/master key/i)).toBeInTheDocument()
    })

    it('restores with the trimmed master key', async () => {
      h.submitRecoveryKey.mockResolvedValue(undefined)
      render(<VerifyDeviceScreen />)
      // No passkey → the master-key field is shown directly (no "choose" step).
      fireEvent.change(screen.getByPlaceholderText(/master key/i), { target: { value: '  k  ' } })
      fireEvent.click(screen.getByRole('button', { name: /^restore$/i }))
      await waitFor(() => expect(h.submitRecoveryKey).toHaveBeenCalledWith('k'))
    })

    it('always offers a way out — sign out (no hard lockout)', () => {
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
      expect(h.signOut).toHaveBeenCalledTimes(1)
    })
  })

  describe('at-rest unlock gate', () => {
    beforeEach(() => {
      h.recoveryPrompt = { kind: 'unlock', custody: 'passkey' }
      h.passkeyAvailable = true
    })

    it('prompts to unlock with the passkey', async () => {
      h.unlockSessionWithPasskey.mockResolvedValue(undefined)
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /unlock with passkey/i }))
      await waitFor(() => expect(h.unlockSessionWithPasskey).toHaveBeenCalledTimes(1))
    })

    it('offers a sign-out escape even when unlock is impossible', () => {
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
      expect(h.signOut).toHaveBeenCalledTimes(1)
    })

    it('keeps the escape in the recovery-key view (manual custody)', () => {
      h.recoveryPrompt = { kind: 'unlock', custody: 'manual' }
      render(<VerifyDeviceScreen />)
      expect(screen.getByPlaceholderText(/recovery key/i)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
      expect(h.signOut).toHaveBeenCalledTimes(1)
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
