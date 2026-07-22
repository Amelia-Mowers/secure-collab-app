import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { SendFailureBanner } from './SendFailureBanner'

function makeWorkspace(count: number, lastReason = 'the server rejected the change') {
  const info = { count, lastReason }
  return {
    info,
    rejectedWrites: vi.fn(() => JSON.stringify(info)),
  }
}

describe('SendFailureBanner', () => {
  it('renders nothing while no writes have been rejected', () => {
    const { container } = render(<SendFailureBanner workspace={makeWorkspace(0)} />)
    expect(container.firstChild).toBeNull()
  })

  it('surfaces rejected writes with the reason', () => {
    render(<SendFailureBanner workspace={makeWorkspace(3, 'not end-to-end encrypted')} />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      /3 changes couldn't be saved and were reverted — not end-to-end encrypted/,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/history/i)
  })

  it('dismisses, and only NEW rejections re-open it', async () => {
    vi.useFakeTimers()
    const ws = makeWorkspace(2)
    render(<SendFailureBanner workspace={ws} />)
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // Same count on the next poll: stays dismissed.
    await act(async () => {
      vi.advanceTimersByTime(6_000)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // A further rejection re-opens with the incremental count.
    ws.info.count = 3
    await act(async () => {
      vi.advanceTimersByTime(6_000)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/A change couldn't be saved/)
    vi.useRealTimers()
  })

  it('renders nothing for a workspace without the bridge method (mock/local)', () => {
    const { container } = render(<SendFailureBanner workspace={{}} />)
    expect(container.firstChild).toBeNull()
  })
})
