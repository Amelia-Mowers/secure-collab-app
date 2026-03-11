import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Mock the WASM module at the file level so we don't need the binary for
// smoke tests of the top-level App shell.
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

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <App />
    </MemoryRouter>,
  )
}

describe('App shell', () => {
  it('shows a loading spinner while the workspace initialises', () => {
    renderApp()
    // The async WASM init hasn't resolved yet – loading spinner is visible
    expect(screen.getByText(/Initializing workspace/i)).toBeInTheDocument()
  })

  it('shows the welcome screen once the workspace is ready', async () => {
    renderApp()
    await waitFor(
      () => expect(screen.getByText('Secure Collaborative Workspace')).toBeInTheDocument(),
      { timeout: 3000 },
    )
  })

  it('shows all three feature cards on the welcome screen', async () => {
    renderApp()
    await waitFor(
      () => expect(screen.getByText('End-to-End Encrypted')).toBeInTheDocument(),
      { timeout: 3000 },
    )
    expect(screen.getByText('Real-time Sync')).toBeInTheDocument()
    expect(screen.getByText('Decentralized')).toBeInTheDocument()
  })

  it('renders the sidebar', async () => {
    renderApp()
    await waitFor(
      () => expect(screen.getByText('Tables')).toBeInTheDocument(),
      { timeout: 3000 },
    )
  })
})
