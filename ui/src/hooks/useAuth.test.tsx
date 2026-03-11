/**
 * Tests for the AuthProvider: sign-in, session persistence, session restore,
 * workspace CRUD, sign-out, multi-account, and legacy migration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

vi.mock('@/wasm/app_core.js', () => ({
  default: vi.fn().mockResolvedValue(undefined),
  init_panic_hook: vi.fn(),
  MatrixSession: {
    login: (...args: any[]) => mockLogin(...args),
    restore: (...args: any[]) => mockRestore(...args),
  },
}))

import { AuthProvider, useAuth } from './useAuth'

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
      )
    })

    it('refreshes workspace list from server after restore', async () => {
      storeAccount('@alice:localhost', 'alice', SESSION_DATA_JSON)

      renderAuth()

      await waitFor(() => {
        expect(screen.getByTestId('consumer').textContent).toContain('[1 workspaces]')
      })
    })

    it('removes stale account and shows error when restore fails (expired token)', async () => {
      mockRestore.mockRejectedValueOnce(new Error('Token expired'))

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
