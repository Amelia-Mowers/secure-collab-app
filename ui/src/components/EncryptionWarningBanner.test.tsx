import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { EncryptionWarningBanner } from './EncryptionWarningBanner'

describe('EncryptionWarningBanner', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('warns when there are undecryptable items', () => {
    render(<EncryptionWarningBanner workspace={{ undecryptableCount: () => 3 }} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/3 items/)
    expect(alert.textContent).toMatch(/couldn.t be decrypted/i)
  })

  it('uses singular wording for a single item', () => {
    render(<EncryptionWarningBanner workspace={{ undecryptableCount: () => 1 }} />)
    expect(screen.getByRole('alert').textContent).toMatch(/1 item /)
  })

  it('renders nothing when the count is zero', () => {
    const { container } = render(
      <EncryptionWarningBanner workspace={{ undecryptableCount: () => 0 }} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for a workspace without undecryptableCount (local / mock)', () => {
    const { container } = render(<EncryptionWarningBanner workspace={{}} />)
    expect(container).toBeEmptyDOMElement()
  })

  // The reason the count is a list of event IDs rather than a tally: keys
  // usually arrive moments later, and the warning has to be able to go away.
  it('clears itself once the retry decrypts everything', async () => {
    vi.useFakeTimers()
    const retryUndecryptable = vi.fn(async () => 0)
    render(
      <EncryptionWarningBanner workspace={{ undecryptableCount: () => 2, retryUndecryptable }} />,
    )
    expect(screen.getByRole('alert')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100)
    })

    expect(retryUndecryptable).toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps retrying, on a widening delay, while events stay unreadable', async () => {
    vi.useFakeTimers()
    const retryUndecryptable = vi.fn(async () => 1)
    render(
      <EncryptionWarningBanner workspace={{ undecryptableCount: () => 1, retryUndecryptable }} />,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100)
    })
    expect(retryUndecryptable).toHaveBeenCalledTimes(1)

    // Still 2s away from the first delay, but the second wait is 4s — proof the
    // backoff widened rather than hammering a server that has no key to give.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100)
    })
    expect(retryUndecryptable).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100)
    })
    expect(retryUndecryptable).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
