import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ConnectionStatus } from './ConnectionStatus'
import { DEGRADED_AFTER_MS, DOWN_AFTER_MS } from '../hooks/useConnectionHealth'

/** A workspace whose sync last answered `ms` ago. */
function workspaceSilentFor(ms: number) {
  return { connectionHealth: () => JSON.stringify({ msSinceLastSyncOk: ms }) }
}

/** Advance the clock (and so the poll) by `ms`. Because the hook only counts
 *  silence it could actually observe, a test must let that much time pass —
 *  reporting a big `msSinceLastSyncOk` alone is deliberately not enough. */
const tick = (ms = 6_000) => act(() => { vi.advanceTimersByTime(ms) })

describe('ConnectionStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows nothing while the server is answering', () => {
    const { container } = render(<ConnectionStatus workspace={workspaceSilentFor(1_000)} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a non-blocking badge for a brief silence, not a modal', () => {
    // Long enough to notice, far short of the write lock.
    render(<ConnectionStatus workspace={workspaceSilentFor(DEGRADED_AFTER_MS + 5_000)} />)
    tick(DEGRADED_AFTER_MS + 5_000)
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument()
    // The key property: editing is NOT blocked.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('does not react at all to a silence shorter than the degraded threshold', () => {
    const { container } = render(
      <ConnectionStatus workspace={workspaceSilentFor(DEGRADED_AFTER_MS - 10_000)} />,
    )
    tick(DEGRADED_AFTER_MS + 30_000)
    expect(container).toBeEmptyDOMElement()
  })

  it('locks writes only once the silence is sustained', () => {
    render(<ConnectionStatus workspace={workspaceSilentFor(DOWN_AFTER_MS + 10_000)} />)
    tick(DOWN_AFTER_MS + 10_000)
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('Still reconnecting')).toBeInTheDocument()
  })

  it('a browser-offline signal degrades immediately but does not lock', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    render(<ConnectionStatus workspace={workspaceSilentFor(0)} />)
    expect(screen.getByText('Offline')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('ignores silence from time the tab was suspended (the wake-from-sleep bug)', () => {
    // The bridge reports hours of silence — but the tab only just came back, so
    // none of it was observed and none of it is evidence the server is down.
    render(<ConnectionStatus workspace={workspaceSilentFor(4 * 60 * 60 * 1000)} />)
    // Sit awake well past the lock threshold BEFORE the resume, to prove it's
    // the resume that clears it and not merely a short elapsed time.
    tick(DOWN_AFTER_MS + 60_000)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    tick()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('never wedges the app when health is unreadable', () => {
    const broken = { connectionHealth: () => 'not json' }
    const { container } = render(<ConnectionStatus workspace={broken} />)
    tick(DOWN_AFTER_MS + 10_000)
    expect(container).toBeEmptyDOMElement()
  })
})
