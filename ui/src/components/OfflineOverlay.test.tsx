import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { OfflineOverlay } from './OfflineOverlay'

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value })
}

describe('OfflineOverlay', () => {
  afterEach(() => {
    setOnline(true)
    cleanup()
  })

  it('renders nothing while online', () => {
    setOnline(true)
    const { container } = render(<OfflineOverlay />)
    expect(container.firstChild).toBeNull()
  })

  it('blocks with an offline message + Reload button when offline', () => {
    setOnline(false)
    render(<OfflineOverlay />)
    expect(screen.getByText(/you're offline/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument()
  })

  it('clears automatically when the connection returns', () => {
    setOnline(false)
    const { container } = render(<OfflineOverlay />)
    expect(container.firstChild).not.toBeNull()
    act(() => {
      setOnline(true)
      window.dispatchEvent(new Event('online'))
    })
    expect(container.firstChild).toBeNull()
  })
})
