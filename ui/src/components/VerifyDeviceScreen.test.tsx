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
  // Annotated: an inferred `never[]` makes every mockResolvedValue below a type error.
  listResettableWorkspaces: vi.fn(
    async (): Promise<
      Array<{ id: string; name: string; amAdmin: boolean; others: Array<{ id: string; label: string; role: string }> }>
    > => [],
  ),
  resetAccount: vi.fn(async () => "NEW-KEY-9999"),
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
    listResettableWorkspaces: h.listResettableWorkspaces,
    resetAccount: h.resetAccount,
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
    })
  })

  // The checkbox is self-attestation, and on this screen self-attestation is
  // what everybody clicks. This step makes them show the key instead.
  describe('prove the key was saved', () => {
    const KEY = 'EsTb 7Kq2 mW9x 4Ldp Rn5J vH8c Zy3T gQ6f Bs1N eK4w Xm2R uP7a'
    const groups = KEY.split(' ')

    beforeEach(() => {
      h.recoveryPrompt = { kind: 'save', recoveryKey: KEY }
    })

    /** Acknowledge, continue, and report which groups were asked for. */
    const reachChallenge = () => {
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('checkbox'))
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
      const labels = screen.getAllByText(/^Group \d+$/).map(el => Number(el.textContent!.slice(6)))
      return labels
    }

    const fill = (asked: number[], values: (n: number) => string) => {
      asked.forEach(n => {
        fireEvent.change(screen.getByLabelText(`Group ${n} of your recovery key`), {
          target: { value: values(n) },
        })
      })
    }

    it('does not finish setup on the acknowledgement alone', () => {
      reachChallenge()
      expect(h.confirmKeySaved).not.toHaveBeenCalled()
    })

    it('hides the key, so this tests the saved copy and not the screen', () => {
      reachChallenge()
      expect(screen.queryByText(KEY)).not.toBeInTheDocument()
    })

    it('asks for two distinct groups', () => {
      const asked = reachChallenge()
      expect(asked).toHaveLength(2)
      expect(new Set(asked).size).toBe(2)
      asked.forEach(n => expect(n).toBeGreaterThanOrEqual(1))
      asked.forEach(n => expect(n).toBeLessThanOrEqual(groups.length))
    })

    it('completes setup when the groups are right', () => {
      const asked = reachChallenge()
      fill(asked, n => groups[n - 1])
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
      expect(h.confirmKeySaved).toHaveBeenCalledWith(KEY)
    })

    it('accepts a different case — re-typing it exactly is not the skill tested', () => {
      const asked = reachChallenge()
      fill(asked, n => groups[n - 1].toUpperCase())
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
      expect(h.confirmKeySaved).toHaveBeenCalledWith(KEY)
    })

    it('rejects a wrong group and says so, without leaving the step', () => {
      const asked = reachChallenge()
      fill(asked, () => 'wrong')
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
      expect(h.confirmKeySaved).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent(/does not match/i)
    })

    // Not a trap: the key is one click away for as long as this screen is up.
    it('can show the key again', () => {
      reachChallenge()
      fireEvent.click(screen.getByRole('button', { name: /show the key again/i }))
      expect(screen.getByText(KEY)).toBeInTheDocument()
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

    it('ROUTES a PRF-incapable passkey to the master key', async () => {
      // Same rule as the at-rest gate: a capability failure moves the user on,
      // a cancellation leaves them where they are.
      h.passkeyAvailable = true
      h.passkeyEnrolled = true
      h.unlockWithPasskey.mockRejectedValueOnce(
        new Error('This passkey does not support PRF — a recovery key is required'),
      )
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /unlock with passkey/i }))

      await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument())
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

    it('offers the recovery key alongside the passkey, unprompted', () => {
      // Both options, always. The passkey is the default for a passkey-custody
      // account, not the only way in.
      render(<VerifyDeviceScreen />)
      expect(screen.getByRole('button', { name: /unlock with passkey/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /use your recovery key/i })).toBeInTheDocument()
    })

    it('ROUTES a PRF-incapable passkey to the recovery key', async () => {
      // A provider that cannot do PRF has no retry that will ever work, so
      // leaving the user on that button is a dead end. The screen switches and
      // explains why. (issue 63dc1339)
      h.unlockSessionWithPasskey.mockRejectedValueOnce(
        new Error("This passkey provider doesn't support WebAuthn PRF"),
      )
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /unlock with passkey/i }))

      await waitFor(() =>
        expect(screen.getByPlaceholderText(/recovery key/i)).toBeInTheDocument(),
      )
      expect(screen.getByText(/can't unlock TideWork/i)).toBeInTheDocument()
    })

    it('does NOT route a cancellation — retrying the passkey is right there', async () => {
      h.unlockSessionWithPasskey.mockRejectedValueOnce(new Error('Passkey unlock was cancelled'))
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /unlock with passkey/i }))

      await waitFor(() =>
        expect(screen.getByText(/Passkey unlock was cancelled/)).toBeInTheDocument(),
      )
      expect(screen.getByRole('button', { name: /unlock with passkey/i })).toBeInTheDocument()
      expect(screen.queryByPlaceholderText(/recovery key/i)).not.toBeInTheDocument()
    })
  })

  describe('nuclear reset (cannot verify at all)', () => {
    const SHARED = {
      id: '!shared:x',
      name: 'Team Space',
      amAdmin: true,
      others: [
        { id: '@bob:x', label: 'Bob', role: 'editor' },
        { id: '@carol:x', label: 'Carol', role: 'admin' },
      ],
    }
    const SOLO = { id: '!solo:x', name: 'Just Me', amAdmin: true, others: [] }

    beforeEach(() => {
      h.recoveryPrompt = { kind: 'verify' }
      h.listResettableWorkspaces.mockResolvedValue([SHARED, SOLO])
      h.resetAccount.mockResolvedValue('NEW-KEY-9999')
    })

    const openReset = () => {
      render(<VerifyDeviceScreen />)
      fireEvent.click(screen.getByRole('button', { name: /reset my account/i }))
    }

    it('is offered as an escape from the verify gate', () => {
      // A user with no key and no working passkey needs a way FORWARD, not just
      // a way out — signing out alone leaves the account unusable.
      openReset()
      expect(screen.getByRole('heading', { name: /reset this account/i })).toBeInTheDocument()
    })

    it('is offered from the at-rest unlock gate too', () => {
      h.recoveryPrompt = { kind: 'unlock', custody: 'manual' }
      render(<VerifyDeviceScreen />)
      expect(screen.getByRole('button', { name: /reset my account/i })).toBeInTheDocument()
    })

    it('states the permanent cost before anything happens', () => {
      openReset()
      expect(screen.getByText(/permanently unreadable/i)).toBeInTheDocument()
      expect(h.listResettableWorkspaces).not.toHaveBeenCalled()
    })

    it('cancelling returns to the gate, having changed nothing', async () => {
      openReset()
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: /verify this device/i })).toBeInTheDocument(),
      )
      expect(h.resetAccount).not.toHaveBeenCalled()
    })

    it('defaults a shared workspace to hand-off and a solo one to delete', async () => {
      // Hand-off is the safer default wherever there is anyone to hand to: it
      // keeps their data. With nobody else present, delete is the only outcome.
      openReset()
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))

      await waitFor(() => expect(screen.getByText('Team Space')).toBeInTheDocument())
      expect(screen.getByLabelText(/successor for Team Space/i)).toHaveValue('@bob:x')
      expect(screen.getByText(/Nobody else is in it, so it will be deleted/i)).toBeInTheDocument()
    })

    it('carries out the chosen plan', async () => {
      openReset()
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
      await waitFor(() => expect(screen.getByText('Team Space')).toBeInTheDocument())

      // Hand Team Space to Carol instead of the default.
      fireEvent.change(screen.getByLabelText(/successor for Team Space/i), {
        target: { value: '@carol:x' },
      })
      fireEvent.click(screen.getByRole('button', { name: /reset my account/i }))

      await waitFor(() =>
        expect(h.resetAccount).toHaveBeenCalledWith([
          { id: '!shared:x', action: 'handoff', successor: '@carol:x' },
          { id: '!solo:x', action: 'delete' },
        ]),
      )
    })

    it('shows the fresh key and requires acknowledgement before signing out', async () => {
      openReset()
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
      await waitFor(() => expect(screen.getByText('Team Space')).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /reset my account/i }))

      await waitFor(() => expect(screen.getByText('NEW-KEY-9999')).toBeInTheDocument())
      const done = screen.getByRole('button', { name: /sign in again/i })
      expect(done).toBeDisabled()
      fireEvent.click(screen.getByRole('checkbox'))
      fireEvent.click(done)

      // The new key is exactly as unrecoverable as a first one, and the user
      // has just destroyed the old one to get it — so it takes the same proof.
      // This mock key is a single whitespace-delimited group, so one is asked.
      expect(h.signOut).not.toHaveBeenCalled()
      fireEvent.change(screen.getByLabelText('Group 1 of your recovery key'), {
        target: { value: 'NEW-KEY-9999' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
      expect(h.signOut).toHaveBeenCalledTimes(1)
    })

    it('a failed reset says the existing key still works', async () => {
      // Workspaces are processed before the key is rotated, so a failure here has
      // cost the user nothing — the message must not imply otherwise.
      h.resetAccount.mockRejectedValueOnce(new Error('Could not remove Bob'))
      openReset()
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
      await waitFor(() => expect(screen.getByText('Team Space')).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /reset my account/i }))

      await waitFor(() => expect(screen.getByText(/existing key still works/i)).toBeInTheDocument())
      expect(screen.getByText(/Could not remove Bob/)).toBeInTheDocument()
    })

    it('handles an account with no workspaces', async () => {
      h.listResettableWorkspaces.mockResolvedValue([])
      openReset()
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
      await waitFor(() => expect(screen.getByText(/not in any workspaces/i)).toBeInTheDocument())
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
