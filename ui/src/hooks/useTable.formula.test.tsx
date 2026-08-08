import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useTable } from './useTable'

/**
 * Formula cells are computed at READ time in the core and never stored
 * (see `workspace.rs`). The hook's optimistic path patches only the edited
 * cell, which is right for a stored value and wrong for a derived one — so a
 * formula depending on the edited cell kept its old answer until something
 * else forced a re-read. In the product that meant a total that only caught up
 * when you switched views or reloaded the page.
 *
 * This workspace reproduces that shape faithfully: `getTableRows` derives
 * `total` on every call, exactly as the bridge does, so nothing here can pass
 * by echoing an optimistic patch back.
 */
function makeWorkspace(opts: { withFormula: boolean }) {
  const state: Record<string, unknown> = { _row_id: 'r1', qty: 2, price: 10 }
  const getTableRows = vi.fn(() =>
    JSON.stringify([
      opts.withFormula
        ? { ...state, total: Number(state.qty) * Number(state.price) }
        : { ...state },
    ]),
  )
  return {
    state,
    getTableRows,
    getTableSchema: () =>
      JSON.stringify({
        columns: {
          qty: { id: 'qty', name: 'Qty', column_type: 'number' },
          price: { id: 'price', name: 'Price', column_type: 'number' },
          ...(opts.withFormula
            ? { total: { id: 'total', name: 'Total', column_type: 'formula' } }
            : {}),
        },
      }),
    updateCell: vi.fn(async (_t: string, _r: string, col: string, valueJson: string) => {
      state[col] = JSON.parse(valueJson)
    }),
  }
}

async function setup(ws: ReturnType<typeof makeWorkspace>) {
  const hook = renderHook(() => useTable(ws as any, 'orders', 'w1', 0))
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  return hook
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useTable formula recomputation', () => {
  it('recomputes a formula cell when a cell it depends on is edited', async () => {
    const ws = makeWorkspace({ withFormula: true })
    const hook = await setup(ws)
    expect(hook.result.current.rows[0].total).toBe(20)

    await act(() => hook.result.current.updateCell('r1', 'qty', 5))

    // No sync tick, no remount, no route change — the edit alone must be
    // enough. This is the assertion the bug would fail: `total` stayed 20
    // while `qty` showed 5.
    await waitFor(() => expect(hook.result.current.rows[0].total).toBe(50))
    expect(hook.result.current.rows[0].qty).toBe(5)
  })

  it('leaves tables without formulas on the cheap path', async () => {
    const ws = makeWorkspace({ withFormula: false })
    const hook = await setup(ws)
    const readsAfterLoad = ws.getTableRows.mock.calls.length

    await act(() => hook.result.current.updateCell('r1', 'qty', 5))

    // `getTableRows` is the hot call; re-reading it on every edit of every
    // table would be a real cost for a case most tables do not have.
    expect(ws.getTableRows.mock.calls.length).toBe(readsAfterLoad)
    expect(hook.result.current.rows[0].qty).toBe(5)
  })

  it('does not re-read while another write is still in flight', async () => {
    const ws = makeWorkspace({ withFormula: true })
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const state = ws.state
    ws.updateCell.mockImplementation(async (_t, _r, col: string, valueJson: string) => {
      if (col === 'price') await gate
      state[col] = JSON.parse(valueJson)
    })

    const hook = await setup(ws)
    // A paste writes several cells at once. The slow one must not have its
    // optimistic value replaced by a re-read the fast one triggered.
    let both: Promise<unknown>
    await act(async () => {
      both = Promise.all([
        hook.result.current.updateCell('r1', 'price', 99),
        hook.result.current.updateCell('r1', 'qty', 5),
      ])
      await Promise.resolve()
    })
    await waitFor(() => expect(hook.result.current.rows[0].price).toBe(99))

    await act(async () => {
      release()
      await both
    })

    // Once everything lands, the formula reflects both edits.
    await waitFor(() => expect(hook.result.current.rows[0].total).toBe(495))
  })
})
