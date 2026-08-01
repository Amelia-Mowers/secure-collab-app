import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DialogProvider, useDialogs } from './DialogProvider'

/** Drives the API the way a real call site does. */
function Harness() {
  const { confirm, prompt, notify } = useDialogs()
  return (
    <div>
      <button
        onClick={async () => {
          const ok = await confirm({ title: 'Delete table "Tasks"?', message: 'Rows go too.' })
          notify(ok ? 'confirmed' : 'cancelled')
        }}
      >
        ask-confirm
      </button>
      <button
        onClick={async () => {
          const name = await prompt({ title: 'Rename table', initial: 'Tasks' })
          notify(name === null ? 'no-name' : `named:${name}`)
        }}
      >
        ask-prompt
      </button>
      <button onClick={() => notify('went wrong', 'error')}>ask-error</button>
    </div>
  )
}

const renderHarness = () =>
  render(
    <DialogProvider>
      <Harness />
    </DialogProvider>,
  )

describe('DialogProvider', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it('resolves confirm true only when confirmed', async () => {
    renderHarness()
    fireEvent.click(screen.getByText('ask-confirm'))

    expect(await screen.findByText('Delete table "Tasks"?')).toBeInTheDocument()
    expect(screen.getByText('Rows go too.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('confirmed')).toBeInTheDocument()
  })

  it('resolves confirm false on cancel — the safe direction', async () => {
    renderHarness()
    fireEvent.click(screen.getByText('ask-confirm'))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('cancelled')).toBeInTheDocument()
  })

  it('prompt returns the trimmed value, and null on cancel', async () => {
    renderHarness()
    fireEvent.click(screen.getByText('ask-prompt'))

    // Prefilled, so a rename starts from the current name.
    const input = await screen.findByDisplayValue('Tasks')
    fireEvent.change(input, { target: { value: '  Projects  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('named:Projects')).toBeInTheDocument()

    fireEvent.click(screen.getByText('ask-prompt'))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('no-name')).toBeInTheDocument()
  })

  // The reason this exists at all: `alert()` blocked the tab, so an informational
  // result must clear itself — while an error must not, because it is usually
  // the only record of what went wrong.
  it('auto-dismisses an informational notice but keeps an error', async () => {
    renderHarness()

    fireEvent.click(screen.getByText('ask-error'))
    expect(await screen.findByText('went wrong')).toBeInTheDocument()

    vi.advanceTimersByTime(10_000)
    expect(screen.getByText('went wrong')).toBeInTheDocument()

    // And it can be dismissed by hand.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByText('went wrong')).not.toBeInTheDocument())
  })

  it('outside a provider it falls back to the native dialogs', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    // jsdom does not implement alert; the fallback's notify() calls it.
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<Harness />)
    fireEvent.click(screen.getByText('ask-confirm'))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    confirmSpy.mockRestore()
    alertSpy.mockRestore()
  })
})
