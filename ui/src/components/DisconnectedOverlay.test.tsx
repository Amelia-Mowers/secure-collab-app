import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { DisconnectedOverlay } from './DisconnectedOverlay'
import { DOWN_AFTER_MS } from '../hooks/useConnectionHealth'

/** A workspace whose bridge health we can steer per call. */
function makeWorkspace(msSinceLastSyncOk: number, extra: Record<string, number> = {}) {
  const health = { msSinceLastSyncOk, pendingCount: 0, consecutiveSendFailures: 0, msSinceLastSendOk: 0, ...extra }
  return {
    health,
    connectionHealth: vi.fn(() => JSON.stringify(health)),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DisconnectedOverlay', () => {
  it('renders nothing while sync is fresh', () => {
    const { container } = render(<DisconnectedOverlay workspace={makeWorkspace(2_000)} />)
    expect(container.firstChild).toBeNull()
  })

  it('locks the UI once sync has been silent past the threshold', () => {
    render(<DisconnectedOverlay workspace={makeWorkspace(DOWN_AFTER_MS + 1_000)} />)
    expect(screen.getByRole('alertdialog', { name: /disconnected/i })).toBeInTheDocument()
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument()
    // Softened copy: unsent edits persist (phase 1), so no data-loss warning.
    expect(screen.getByText(/saved on this device/i)).toBeInTheDocument()
  })

  it('send failures alone do NOT trip the lock while sync answers', () => {
    // A rate-limited send with live sync = server up; that's failure
    // classification (phase 3), not a disconnect.
    const ws = makeWorkspace(1_000, { consecutiveSendFailures: 7, msSinceLastSendOk: 120_000 })
    const { container } = render(<DisconnectedOverlay workspace={ws} />)
    expect(container.firstChild).toBeNull()
  })

  it('clears itself when a sync response arrives (next poll)', async () => {
    vi.useFakeTimers()
    const ws = makeWorkspace(DOWN_AFTER_MS + 1_000)
    render(<DisconnectedOverlay workspace={ws} />)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    ws.health.msSinceLastSyncOk = 500 // sync answered
    await act(async () => {
      vi.advanceTimersByTime(6_000) // past the 5s poll
    })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('renders nothing for a workspace without health reporting (mock/local)', () => {
    const { container } = render(<DisconnectedOverlay workspace={{}} />)
    expect(container.firstChild).toBeNull()
  })
})
