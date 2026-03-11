import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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
    expect(screen.getByText('Continue')).toBeInTheDocument()
  })

  it('shows the sign-in page at /signin', () => {
    renderAt('/signin')
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument()
    expect(screen.getByText('Continue')).toBeInTheDocument()
  })

  it('shows the stub note on sign-in page', () => {
    renderAt('/signin')
    expect(screen.getByText(/Matrix authentication coming soon/i)).toBeInTheDocument()
  })

  it('signing in navigates to /workspaces', async () => {
    renderAt('/signin')
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Alice' } })
    fireEvent.click(screen.getByText('Continue'))
    await waitFor(() => expect(screen.getByText('Workspaces')).toBeInTheDocument())
  })

  it('shows workspaces page when authenticated', async () => {
    localStorage.setItem('collab:username', 'Alice')
    renderAt('/workspaces')
    await waitFor(() => expect(screen.getByText('Workspaces')).toBeInTheDocument())
    expect(screen.getByText('New workspace')).toBeInTheDocument()
  })

  it('shows the workspace shell (sidebar) when navigating into a workspace', async () => {
    localStorage.setItem('collab:username', 'Alice')
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
