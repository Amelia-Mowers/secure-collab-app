import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

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
  ConnectedWorkspace: vi.fn().mockImplementation(() => ({
    listTables: () => '[]',
    listViewsForTable: () => '[]',
    getView: () => { throw new Error('no view') },
    getTableSchema: () => { throw new Error('no schema') },
    startSync: vi.fn(),
  })),
  MatrixSession: {
    login: vi.fn().mockResolvedValue({
      initialSync: vi.fn().mockResolvedValue(undefined),
      userId: () => '@alice:localhost',
      listRooms: () => '[]',
      createRoom: vi.fn().mockResolvedValue('!room1:localhost'),
    }),
  },
}))

import App from './App'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

describe('App shell', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('redirects unauthenticated users to /signin from /', () => {
    renderAt('/')
    expect(screen.getByText('Sign in')).toBeInTheDocument()
  })

  it('shows the sign-in page at /signin', () => {
    renderAt('/signin')
    expect(screen.getByLabelText(/homeserver/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument()
    expect(screen.getByText('Sign in')).toBeInTheDocument()
  })

  it('shows the Matrix connection hint on sign-in page', () => {
    renderAt('/signin')
    expect(screen.getByText(/Connect to any Matrix homeserver/i)).toBeInTheDocument()
  })

  it('shows workspaces page when authenticated', async () => {
    localStorage.setItem('collab:session', JSON.stringify({
      homeserverUrl: 'http://localhost:6167',
      userId: '@alice:localhost',
      username: 'alice',
    }))
    renderAt('/workspaces')
    await waitFor(() => expect(screen.getByText('Workspaces')).toBeInTheDocument())
    expect(screen.getByText('New workspace')).toBeInTheDocument()
    expect(screen.getByText('Join workspace')).toBeInTheDocument()
  })

  it('shows the workspace shell (sidebar) when navigating into a workspace', async () => {
    localStorage.setItem('collab:session', JSON.stringify({
      homeserverUrl: 'http://localhost:6167',
      userId: '@alice:localhost',
      username: 'alice',
    }))
    localStorage.setItem('collab:workspaces', JSON.stringify([
      { id: 'ws_test_1', name: 'Test WS', createdAt: 0 },
    ]))
    renderAt('/workspace/ws_test_1')
    await waitFor(
      () => expect(screen.getByText('Tables')).toBeInTheDocument(),
      { timeout: 3000 },
    )
  })
})
