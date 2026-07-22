import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useTable } from './useTable'

/** Minimal workspace whose rows we can mutate to simulate remote writes. */
function makeWorkspace(initial: Record<string, unknown>) {
  const state = { row: { _row_id: 'r1', ...initial } }
  return {
    state,
    getTableRows: () => JSON.stringify([state.row]),
    updateCell: vi.fn(async (_t: string, _r: string, col: string, valueJson: string) => {
      // The optimistic local apply the real bridge performs.
      const row = state.row as Record<string, unknown>
      row[col] = JSON.parse(valueJson)
    }),
  }
}

/** Simulate a remote writer winning LWW: the store's value changes under us. */
function setTitle(ws: ReturnType<typeof makeWorkspace>, value: string) {
  const row = ws.state.row as Record<string, unknown>
  row.title = value
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useTable conflict flagging (ADR 0003 item 4)', () => {
  async function setup(ws: ReturnType<typeof makeWorkspace>) {
    const hook = renderHook(
      ({ sc }: { sc: number }) => useTable(ws as any, 'tasks', 'w1', sc),
      { initialProps: { sc: 0 } },
    )
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    return hook
  }

  it('flags a cell whose recent edit a remote write overwrote, then clears', async () => {
    const ws = makeWorkspace({ title: 'original' })
    const hook = await setup(ws)

    await act(() => hook.result.current.updateCell('r1', 'title', 'mine'))
    // Remote writer wins LWW: the store now shows a different value.
    setTitle(ws, 'theirs')
    hook.rerender({ sc: 1 }) // sync-driven re-read

    await waitFor(() =>
      expect(hook.result.current.conflictCells.has('r1:title')).toBe(true),
    )
    // The re-read replaced the optimistic value with the winner.
    expect(hook.result.current.rows[0].title).toBe('theirs')
    // The flag expires (flash, not a permanent marker).
    await waitFor(
      () => expect(hook.result.current.conflictCells.size).toBe(0),
      { timeout: 4_000 },
    )
  })

  it('does NOT flag when the re-read echoes the user\'s own value', async () => {
    const ws = makeWorkspace({ title: 'original' })
    const hook = await setup(ws)

    await act(() => hook.result.current.updateCell('r1', 'title', 'mine'))
    // Sync echo of our own write — same value, no conflict.
    hook.rerender({ sc: 1 })

    await waitFor(() => expect(hook.result.current.rows[0].title).toBe('mine'))
    expect(hook.result.current.conflictCells.size).toBe(0)
  })

  it('does NOT flag edits older than the conflict window', async () => {
    vi.useFakeTimers()
    const ws = makeWorkspace({ title: 'original' })
    const hook = renderHook(
      ({ sc }: { sc: number }) => useTable(ws as any, 'tasks', 'w1', sc),
      { initialProps: { sc: 0 } },
    )
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })

    await act(() => hook.result.current.updateCell('r1', 'title', 'mine'))
    await act(async () => {
      vi.advanceTimersByTime(20_000) // past the 15s window
    })
    setTitle(ws, 'theirs')
    hook.rerender({ sc: 1 })
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    // Stale edit: the overwrite is just normal convergence, no flag.
    expect(hook.result.current.conflictCells.size).toBe(0)
  })
})
