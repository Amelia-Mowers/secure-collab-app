/**
 * Tests for the AuthProvider: sign-in, session persistence, session restore,
 * workspace CRUD, sign-out, multi-account, and legacy migration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'

// ── Mock MatrixSession ───────────────────────────────────────────────────────

const SESSION_DATA_JSON =
  '{"userId":"@alice:localhost","deviceId":"DEV1","accessToken":"syt_tok"}'

const BOB_SESSION_DATA_JSON =
  '{"userId":"@bob:localhost","deviceId":"DEV2","accessToken":"syt_bob"}'

function makeMockSession(userId = '@alice:localhost') {
  return {
    initialSync: vi.fn().mockResolvedValue(undefined),
    userId: () => userId,
    sessionData: () =>
      userId === '@alice:localhost' ? SESSION_DATA_JSON : BOB_SESSION_DATA_JSON,
    listRooms: vi.fn().mockResolvedValue(
      JSON.stringify([
        { id: '!ws1:localhost', name: 'My Workspace', isWorkspace: true },
        { id: '!admin:localhost', name: 'Admin Room', isWorkspace: false },
      ]),
    ),
    createRoom: vi.fn().mockResolvedValue('!newroom:localhost'),
    joinRoom: vi.fn().mockResolvedValue(undefined),
  }
}

const mockLogin = vi.fn().mockImplementation((_hs: string, user: string) => {
  const uid = `@${user}:localhost`
  return Promise.resolve(makeMockSession(uid))
})
const mockRestore = vi.fn().mockImplementation((_hs: string, json: string) => {
  const data = JSON.parse(json)
  return Promise.resolve(makeMockSession(data.userId))
})

vi.mock('@/wasm/generated/app_core.js', () => ({
  default: vi.fn().mockResolvedValue(undefined),
  init_panic_hook: vi.fn(),
  MatrixSession: {
    login: (...args: any[]) => mockLogin(...args),
    restore: (...args: any[]) => mockRestore(...args),
  },
}))

import { AuthProvider, useAuth, RECOVERY_BOOTSTRAP_DELAYS_MS } from './useAuth'

// ── Test harness ─────────────────────────────────────────────────────────────

/** Renders a consumer that exposes auth state for assertions. */
function AuthConsumer({ onState }: { onState: (state: ReturnType<typeof useAuth>) => void }) {
  const state = useAuth()
  onState(state)
  return createElement('div', { 'data-testid': 'consumer' },
    state.username ? `Hello, ${state.username}` : 'Not signed in',
    state.loading ? ' (loading)' : '',
    state.error ? ` [error: ${state.error}]` : '',
    state.matrixSession ? ' [matrix]' : ' [no-matrix]',
    ` [${state.workspaces.length} workspaces]`,
    ` [${state.accounts.length} accounts]`,
  )
}

function renderAuth(onState?: (s: ReturnType<typeof useAuth>) => void) {
  const stateRef = { current: null as any }
  const callback = onState ?? ((s: any) => { stateRef.current = s })
  const result = render(
    createElement(MemoryRouter, null,
      createElement(AuthProvider, null,
        createElement(AuthConsumer, { onState: callback }),
      ),
    ),
  )
  return { ...result, getState: () => stateRef.current as ReturnType<typeof useAuth> }
}

/** Helper: store an account in the new multi-account format. */
function storeAccount(userId: string, username: string, sessionData: string) {
  const existing = JSON.parse(localStorage.getItem('collab:accounts') ?? '[]')
  existing.push({
    homeserverUrl: 'http://localhost:6167',
    userId,
    username,
    matrixSessionData: sessionData,
  })
  localStorage.setItem('collab:accounts', JSON.stringify(existing))
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AuthProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    mockLogin.mockClear()
    mockRestore.mockClear()
  })

  describe('initial state', () => {
    it('starts with no user when storage is empty', () => {
      renderAuth()
      expect(screen.getByTestId('consumer').textContent).toContain('Not signed in')
      expect(screen.getByTestId('consumer').textContent).toContain('[no-matrix]')
      expect(screen.getByTestId('consumer').textContent).toContain('[0 accounts]')
    })

    it('shows username from stored accounts before restore completes', () => {
      storeAccount('@alice:localhost', 'alice', SESSION_DATA_JSON)
      renderAuth()
      // Username is available synchronously from localStorage
      expect(screen.getByTestId('consumer').textContent).toContain('Hello, alice')
    })
  })

  describe('signIn', () => {
    it('sets username, matrixSession, and workspaces after login', async () => {
      const { getState } = renderAuth()

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'alice', 'password123')
      })

      await waitFor(() => {
        expect(screen.getByTestId('consumer').textContent).toContain('Hello, alice')
        expect(screen.getByTestId('consumer').textContent).toContain('[matrix]')
        expect(screen.getByTestId('consumer').textContent).toContain('[1 workspaces]')
      })
    })

    it('persists account data to collab:accounts in localStorage', async () => {
      const { getState } = renderAuth()

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'alice', 'pw')
      })

      const accounts = JSON.parse(localStorage.getItem('collab:accounts')!)
      expect(accounts).toHaveLength(1)
      expect(accounts[0].username).toBe('alice')
      expect(accounts[0].homeserverUrl).toBe('http://localhost:6167')
      expect(accounts[0].matrixSessionData).toBe(SESSION_DATA_JSON)
    })

    it('filters workspace rooms from non-workspace rooms', async () => {
      const { getState } = renderAuth()

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'alice', 'pw')
      })

      const state = getState()
      expect(state.workspaces).toHaveLength(1)
      expect(state.workspaces[0].name).toBe('My Workspace')
      // Admin Room should be filtered out
      expect(state.workspaces.find(w => w.name === 'Admin Room')).toBeUndefined()
    })

    it('sets error on login failure', async () => {
      mockLogin.mockRejectedValueOnce(new Error('Invalid password'))
      const { getState } = renderAuth()

      // signIn throws — catch it so we can inspect the error state
      await act(async () => {
        try {
          await getState().signIn('http://localhost:6167', 'alice', 'wrong')
        } catch {
          // expected
        }
      })

      await waitFor(() => {
        expect(screen.getByTestId('consumer').textContent).toContain('[error: Invalid password]')
      })
    })
  })

  describe('session restore on reload', () => {
    it('restores matrixSession from stored account data on mount', async () => {
      storeAccount('@alice:localhost', 'alice', SESSION_DATA_JSON)

      renderAuth()

      // After restore completes, matrixSession should be available
      await waitFor(() => {
        expect(screen.getByTestId('consumer').textContent).toContain('[matrix]')
      })

      expect(mockRestore).toHaveBeenCalledWith(
        'http://localhost:6167',
        SESSION_DATA_JSON,
        undefined, // store passphrase: v1 (plaintext store) restore
      )
    })

    it('refreshes workspace list from server after restore', async () => {
      storeAccount('@alice:localhost', 'alice', SESSION_DATA_JSON)

      renderAuth()

      await waitFor(() => {
        expect(screen.getByTestId('consumer').textContent).toContain('[1 workspaces]')
      })
    })

    it('removes stale account and shows error when the server REJECTS the session', async () => {
      // A definitive rejection — the server considered the credentials and
      // refused. Only this removes the account.
      mockRestore.mockRejectedValueOnce(new Error('M_UNKNOWN_TOKEN: Invalid access token'))

      storeAccount('@alice:localhost', 'alice', SESSION_DATA_JSON)

      renderAuth()

      await waitFor(() => {
        expect(screen.getByTestId('consumer').textContent).toContain('Not signed in')
        expect(screen.getByTestId('consumer').textContent).toContain('[error: Session expired')
      })

      // Account should be removed from pool
      const accounts = JSON.parse(localStorage.getItem('collab:accounts')!)
      expect(accounts).toHaveLength(0)
    })

    it('KEEPS the account when the homeserver is merely unreachable', async () => {
      // Observed in prod 2026-07-26: MAS was briefly down and the app signed
      // the user out. An unreachable server says nothing about whether the
      // session is still valid, so the account must survive.
      mockRestore.mockRejectedValueOnce(
        new Error('error sending request for url (https://auth.example/)'),
      )

      storeAccount('@alice:localhost', 'alice', SESSION_DATA_JSON)

      renderAuth()

      await waitFor(() => {
        expect(screen.getByTestId('consumer').textContent).toContain('Could not reach')
      })

      const accounts = JSON.parse(localStorage.getItem('collab:accounts')!)
      expect(accounts).toHaveLength(1)
    })
  })

  describe('legacy migration', () => {
    it('migrates from collab:session to collab:accounts format', () => {
      localStorage.setItem('collab:session', JSON.stringify({
        homeserverUrl: 'http://localhost:6167',
        userId: '@alice:localhost',
        username: 'alice',
        matrixSessionData: SESSION_DATA_JSON,
      }))

      renderAuth()

      // Should have migrated
      expect(localStorage.getItem('collab:session')).toBeNull()
      const accounts = JSON.parse(localStorage.getItem('collab:accounts')!)
      expect(accounts).toHaveLength(1)
      expect(accounts[0].username).toBe('alice')

      // Username should show from the migrated data
      expect(screen.getByTestId('consumer').textContent).toContain('Hello, alice')
    })

    it('does not attempt restore when legacy session has no matrixSessionData', () => {
      localStorage.setItem('collab:session', JSON.stringify({
        homeserverUrl: 'http://localhost:6167',
        userId: '@alice:localhost',
        username: 'alice',
        // no matrixSessionData — old format session
      }))

      renderAuth()

      expect(mockRestore).not.toHaveBeenCalled()
    })
  })

  describe('signOut', () => {
    it('clears active account state and removes from pool', async () => {
      const { getState } = renderAuth()

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'alice', 'pw')
      })

      act(() => {
        getState().signOut()
      })

      await waitFor(() => {
        expect(screen.getByTestId('consumer').textContent).toContain('Not signed in')
        expect(screen.getByTestId('consumer').textContent).toContain('[no-matrix]')
        expect(screen.getByTestId('consumer').textContent).toContain('[0 workspaces]')
        expect(screen.getByTestId('consumer').textContent).toContain('[0 accounts]')
      })
    })
  })

  describe('multi-account', () => {
    it('adds multiple accounts to the pool via signIn', async () => {
      const { getState } = renderAuth()

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'alice', 'pw')
      })

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'bob', 'pw')
      })

      await waitFor(() => {
        // Active account is now bob
        expect(screen.getByTestId('consumer').textContent).toContain('Hello, bob')
        expect(screen.getByTestId('consumer').textContent).toContain('[2 accounts]')
      })

      const accounts = JSON.parse(localStorage.getItem('collab:accounts')!)
      expect(accounts).toHaveLength(2)
      expect(accounts.map((a: any) => a.username).sort()).toEqual(['alice', 'bob'])
    })

    it('switchAccount changes the active user', async () => {
      const { getState } = renderAuth()

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'alice', 'pw')
      })

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'bob', 'pw')
      })

      // Switch back to alice
      await act(async () => {
        await getState().switchAccount('@alice:localhost')
      })

      await waitFor(() => {
        expect(screen.getByTestId('consumer').textContent).toContain('Hello, alice')
        expect(screen.getByTestId('consumer').textContent).toContain('[matrix]')
      })
    })

    it('removeAccount removes a non-active account', async () => {
      const { getState } = renderAuth()

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'alice', 'pw')
      })

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'bob', 'pw')
      })

      act(() => {
        getState().removeAccount('@alice:localhost')
      })

      await waitFor(() => {
        // Bob should still be active
        expect(screen.getByTestId('consumer').textContent).toContain('Hello, bob')
        expect(screen.getByTestId('consumer').textContent).toContain('[1 accounts]')
      })
    })

    it('signOut with multiple accounts removes only the active one', async () => {
      const { getState } = renderAuth()

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'alice', 'pw')
      })

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'bob', 'pw')
      })

      // Sign out bob (the active account)
      act(() => {
        getState().signOut()
      })

      await waitFor(() => {
        // Alice should still be in the pool
        expect(screen.getByTestId('consumer').textContent).toContain('[1 accounts]')
      })

      // Alice's account should remain
      const accounts = JSON.parse(localStorage.getItem('collab:accounts')!)
      expect(accounts).toHaveLength(1)
      expect(accounts[0].username).toBe('alice')
    })

    it('stores active account ID in sessionStorage per window', async () => {
      const { getState } = renderAuth()

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'alice', 'pw')
      })

      expect(sessionStorage.getItem('collab:activeAccount')).toBe('@alice:localhost')
    })

    it('stores workspaces per account', async () => {
      const { getState } = renderAuth()

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'alice', 'pw')
      })

      const key = 'collab:workspaces:@alice:localhost'
      const stored = JSON.parse(localStorage.getItem(key)!)
      expect(stored).toHaveLength(1)
      expect(stored[0].name).toBe('My Workspace')
    })
  })

  describe('createWorkspace', () => {
    it('creates a workspace and adds it to the list', async () => {
      const { getState } = renderAuth()

      await act(async () => {
        await getState().signIn('http://localhost:6167', 'alice', 'pw')
      })

      let entry: any
      await act(async () => {
        entry = await getState().createWorkspace('New Project')
      })

      expect(entry.id).toBe('!newroom:localhost')
      expect(entry.name).toBe('New Project')

      // Should be added to state (1 from login + 1 new)
      await waitFor(() => {
        expect(screen.getByTestId('consumer').textContent).toContain('[2 workspaces]')
      })
    })

    it('throws when not signed in', async () => {
      const { getState } = renderAuth()
      await expect(getState().createWorkspace('Test')).rejects.toThrow('Not signed in')
    })
  })
})

// ── Recovery bootstrap: blocking on failure, never silent ────────────────────

describe('recovery bootstrap (first device)', () => {
  // This describe lives outside the AuthProvider block, so it needs its own
  // cleanup — otherwise accounts persisted by earlier tests make the provider
  // auto-restore a stale session concurrently with these flows.
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    mockLogin.mockClear()
    mockRestore.mockClear()
  })

  // The backoff is shrunk to near-zero rather than faked, and the reason is
  // worth keeping: fake timers CANNOT drive this loop. `bootstrapWithKey`
  // schedules attempt N+1's `setTimeout` only after attempt N's promise
  // settles, and since #191 that path runs real WebCrypto, which resolves off
  // the fake clock. A single `advanceTimersByTimeAsync` fires only the timers
  // that exist while it drains, so when the crypto lands after the drain the
  // timer is never fired and the test HANGS — forever, not slowly, so a bigger
  // timeout does not help (that was the first fix attempted, and it changed
  // nothing). Pumping the clock in a loop fails identically: the loop burns
  // through its steps in milliseconds of real time, long before the crypto
  // resolves.
  //
  // So the delays are real, just small. These three tests used to pay ~7s each
  // of genuine sleep for the privilege.
  const realDelays = [...RECOVERY_BOOTSTRAP_DELAYS_MS]
  beforeEach(() => {
    RECOVERY_BOOTSTRAP_DELAYS_MS.splice(0, RECOVERY_BOOTSTRAP_DELAYS_MS.length, 0, 1, 1)
  })
  afterEach(() => {
    RECOVERY_BOOTSTRAP_DELAYS_MS.splice(0, RECOVERY_BOOTSTRAP_DELAYS_MS.length, ...realDelays)
  })

  it('retries with a real backoff, and the shipped policy is three attempts', () => {
    // Asserted on the restored copy, so this describes what SHIPS rather than
    // what the tests below run with.
    expect(realDelays).toEqual([0, 2000, 5000])
  })

  function makeRecoverySession(enableRecovery: () => Promise<string>) {
    return {
      ...makeMockSession('@carol:localhost'),
      recoveryStatus: vi.fn().mockResolvedValue('needs_bootstrap'),
      enableRecovery: vi.fn().mockImplementation(enableRecovery),
    }
  }

  it('shows the save prompt when bootstrap succeeds', async () => {
    const session = makeRecoverySession(async () => 'KEY-ABCD')
    mockLogin.mockResolvedValueOnce(session)

    const { getState } = renderAuth()
    await act(async () => {
      await getState().signIn('http://hs', 'carol', 'pw')
    })

    expect(getState().recoveryPrompt).toEqual({ kind: 'save', recoveryKey: 'KEY-ABCD' })
  })

  it('retries transient failures, then succeeds', async () => {
    let calls = 0
    const session = makeRecoverySession(async () => {
      calls += 1
      if (calls < 2) throw new Error('transient network blip')
      return 'KEY-EFGH'
    })
    mockLogin.mockResolvedValueOnce(session)

    const { getState } = renderAuth()
    await act(async () => {
      await getState().signIn('http://hs', 'carol', 'pw')
    })

    expect(session.enableRecovery).toHaveBeenCalledTimes(2)
    expect(getState().recoveryPrompt).toEqual({ kind: 'save', recoveryKey: 'KEY-EFGH' })
  }, 30_000)

  it('raises a BLOCKING error prompt when every attempt fails (no silent fail-open)', async () => {
    const session = makeRecoverySession(async () => {
      throw new Error('Backup upload failed')
    })
    mockLogin.mockResolvedValueOnce(session)

    const { getState } = renderAuth()
    await act(async () => {
      await getState().signIn('http://hs', 'carol', 'pw')
    })

    expect(session.enableRecovery).toHaveBeenCalledTimes(3)
    expect(getState().recoveryPrompt).toEqual({
      kind: 'error',
      message: 'Backup upload failed',
    })
  }, 30_000)

  it('retryRecoverySetup re-runs the bootstrap from the error state', async () => {
    let fail = true
    const session = makeRecoverySession(async () => {
      if (fail) throw new Error('still down')
      return 'KEY-IJKL'
    })
    mockLogin.mockResolvedValueOnce(session)

    // Phase 1: every attempt fails, so this walks the full real backoff.
    const { getState } = renderAuth()
    await act(async () => {
      await getState().signIn('http://hs', 'carol', 'pw')
    })
    expect(getState().recoveryPrompt?.kind).toBe('error')

    // Phase 2: the retry succeeds on the first, zero-delay attempt.
    fail = false
    await act(async () => {
      await getState().retryRecoverySetup()
    })
    expect(getState().recoveryPrompt).toEqual({ kind: 'save', recoveryKey: 'KEY-IJKL' })
  }, 30_000)
})
