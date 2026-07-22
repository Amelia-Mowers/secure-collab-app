import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { UpdateBanner, CHECK_INTERVAL_MS } from './UpdateBanner'

// __BUILD_ID__ is defined as 'test-build' in vitest.config.ts.

function mockDeployedBuild(build: string | null) {
  const fetchMock = vi.fn(async () =>
    build === null
      ? ({ ok: false } as Response)
      : ({ ok: true, json: async () => ({ build }) } as unknown as Response),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockDeployedBuild('test-build'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('UpdateBanner', () => {
  it('stays hidden while the deployed build matches', async () => {
    const fetchMock = mockDeployedBuild('test-build')
    const { container } = render(<UpdateBanner />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it('offers Reload / Later when a newer build is deployed', async () => {
    mockDeployedBuild('newer-build')
    render(<UpdateBanner />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/new version .* available/i)
    // Reload is safe: the copy says unsaved edits survive (outbox).
    expect(screen.getByRole('alert')).toHaveTextContent(/kept on this device/i)
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument()
  })

  it('Later snoozes one cycle, then the banner returns', async () => {
    mockDeployedBuild('newer-build')
    render(<UpdateBanner />)
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // A check inside the snooze window stays silent (tab-visible trigger)…
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // …but once the snooze expires (Date.now past it), the next check
    // re-prompts. Advance the clock only — the visibility trigger stands in
    // for the 5-minute interval tick.
    const realNow = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + CHECK_INTERVAL_MS + 1_000)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    vi.restoreAllMocks()
  })

  it('a chunk-load failure prompts immediately with firmer copy and no Later', async () => {
    render(<UpdateBanner />)
    act(() => {
      window.dispatchEvent(new Event('vite:preloadError'))
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(/needs a reload to keep working/i)
    expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument()
  })

  it('a failed version check never nags (offline stays silent)', async () => {
    const fetchMock = mockDeployedBuild(null)
    const { container } = render(<UpdateBanner />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })
})
