import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Shared mock session object (reused by login and restore)
function makeMockMatrixSession() {
  return {
    initialSync: vi.fn().mockResolvedValue(undefined),
    userId: () => '@alice:localhost',
    sessionData: () => '{"userId":"@alice:localhost","deviceId":"TESTDEVICE","accessToken":"syt_test"}',
    listRooms: vi.fn().mockResolvedValue('[]'),
    createRoom: vi.fn().mockResolvedValue('!room1:localhost'),
  }
}

// Mock the WASM module so tests don't need the binary
vi.mock('@/wasm/app_core.js', () => ({
  default: vi.fn().mockResolvedValue(undefined),
  init_panic_hook: vi.fn(),
  WasmWorkspace: vi.fn().mockImplementation(() => ({
    listTables: () => '[]',
    listViewsForTable: () => '[]',
    getView: () => { throw new Error('no view') },
    getTableSchema: () => { throw new Error('no schema') },
  })),
  ConnectedWorkspace: {
    create: vi.fn().mockResolvedValue({
      listTables: () => '[]',
      listViewsForTable: () => '[]',
      getView: () => { throw new Error('no view') },
      getTableSchema: () => { throw new Error('no schema') },
      startSync: vi.fn(),
    }),
  },
  MatrixSession: {
    login: vi.fn().mockImplementation(() => Promise.resolve(makeMockMatrixSession())),
    restore: vi.fn().mockImplementation(() => Promise.resolve(makeMockMatrixSession())),
  },
}))

import App from './App'
import { AuthProvider } from './hooks/useAuth'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
}

/** Helper: store an account so auto-restore works (new multi-account format). */
function setStoredSession() {
  localStorage.setItem('collab:accounts', JSON.stringify([{
    homeserverUrl: 'http://localhost:6167',
    userId: '@alice:localhost',
    username: 'alice',
    matrixSessionData: '{"userId":"@alice:localhost","deviceId":"TESTDEVICE","accessToken":"syt_test"}',
  }]))
}

describe('App shell', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('redirects unauthenticated users to /signin from /', () => {
    renderAt('/')
    expect(screen.getByText('Secure Collab')).toBeInTheDocument()
  })

  it('shows the sign-in page at /signin', () => {
    renderAt('/signin')
    expect(screen.getByRole('group', { name: /homeserver/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument()
  })

  it('shows the Matrix connection hint on sign-in page', () => {
    renderAt('/signin')
    expect(screen.getByText(/Connect to any Matrix homeserver/i)).toBeInTheDocument()
  })

  it('shows workspaces page when authenticated', async () => {
    setStoredSession()
    renderAt('/workspaces')
    await waitFor(() => expect(screen.getByText('Workspaces')).toBeInTheDocument())
    expect(screen.getByText('New workspace')).toBeInTheDocument()
    expect(screen.getByText('Advanced')).toBeInTheDocument()
  })

  it('shows the workspace shell (sidebar) when navigating into a workspace', async () => {
    setStoredSession()
    localStorage.setItem('collab:workspaces:@alice:localhost', JSON.stringify([
      { id: 'ws_test_1', name: 'Test WS', createdAt: 0 },
    ]))
    renderAt('/workspace/ws_test_1')
    await waitFor(
      () => expect(screen.getByText('Tables')).toBeInTheDocument(),
      { timeout: 3000 },
    )
  })
})
