import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceHandle } from '../../hooks/useTable'
import './HistoryDrawer.css'

/** One entry from `workspace.getChangeLog` — either a cell edit or a revert. */
type ChangeEntry =
  | {
      kind: 'edit'
      tableId: string
      rowId: string
      columnId: string
      value: unknown
      prevValue: unknown
      sender: string
      serverTs: number
    }
  | {
      kind: 'revert'
      id: string
      actor: string
      target: number
      scope: string
      label: string | null
      serverTs: number
    }

interface HistoryDrawerProps {
  workspace: WorkspaceHandle
  tableId: string
  /** Close the drawer. */
  onClose: () => void
  /** Called after a successful rollback so the parent can re-read rows. */
  onReverted?: () => void
}

/** Short, readable rendering of a cell value for the timeline. */
function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '∅'
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

/** `@alice:server` → `alice` (fall back to the raw id). */
function fmtUser(id: string): string {
  const m = /^@([^:]+):/.exec(id)
  return m ? m[1] : id || 'someone'
}

function fmtTime(ms: number): string {
  if (!ms) return ''
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return ''
  }
}

/**
 * The History drawer: a side panel showing the change log for a table (edits +
 * reverts, newest-first) with the ability to roll the table back to any point.
 * A rollback is recorded as its own entry (the "rollback message") and can
 * itself be reverted, so this is safe to use freely.
 */
export function HistoryDrawer({ workspace, tableId, onClose, onReverted }: HistoryDrawerProps) {
  const [entries, setEntries] = useState<ChangeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyTs, setBusyTs] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!workspace.getChangeLog) {
      setError('History is only available for synced workspaces.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const json = await workspace.getChangeLog(tableId)
      setEntries(JSON.parse(json) as ChangeEntry[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load history.')
    } finally {
      setLoading(false)
    }
  }, [workspace, tableId])

  useEffect(() => {
    void load()
  }, [load])

  const restore = useCallback(
    async (serverTs: number) => {
      if (!workspace.rollbackTo) return
      if (
        !window.confirm(
          'Undo this change and everything after it? This is recorded in history and can itself be reverted.',
        )
      ) {
        return
      }
      setBusyTs(serverTs)
      setNotice(null)
      try {
        // EXCLUSIVE semantics (issue 76987002): the drawer is a change list, so
        // "Restore" on an entry undoes that entry too — target the instant just
        // before it. Entries from one batched Matrix event share a serverTs and
        // revert together (they were one user action). On a revert entry this
        // is revert-the-revert.
        const sent = await workspace.rollbackTo(tableId, serverTs - 1)
        setNotice(sent > 0 ? 'Reverted.' : 'Already at that state — nothing to change.')
        onReverted?.()
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Rollback failed.')
      } finally {
        setBusyTs(null)
      }
    },
    [workspace, tableId, onReverted, load],
  )

  return (
    <div className="history-drawer__scrim" onClick={onClose}>
      <aside
        className="history-drawer"
        role="dialog"
        aria-label="Change history"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="history-drawer__head">
          <span className="history-drawer__title">History</span>
          <button className="history-drawer__close" onClick={onClose} aria-label="Close history">
            ✕
          </button>
        </header>

        {notice && <div className="history-drawer__notice">{notice}</div>}
        {error && <div className="history-drawer__error">{error}</div>}

        {loading ? (
          <div className="history-drawer__empty">Loading history…</div>
        ) : entries.length === 0 ? (
          <div className="history-drawer__empty">No changes recorded yet.</div>
        ) : (
          <ol className="history-drawer__list">
            {entries.map((e, i) => (
              <li
                key={e.kind === 'revert' ? `rev-${e.id}` : `edit-${e.serverTs}-${i}`}
                className={`history-entry history-entry--${e.kind}`}
              >
                <div className="history-entry__body">
                  {e.kind === 'edit' ? (
                    <>
                      <div className="history-entry__line">
                        <span className="history-entry__who">{fmtUser(e.sender)}</span> changed{' '}
                        <span className="history-entry__col">{e.columnId}</span>
                      </div>
                      <div className="history-entry__change">
                        <span className="history-entry__prev">{fmtValue(e.prevValue)}</span>
                        <span className="history-entry__arrow">→</span>
                        <span className="history-entry__next">{fmtValue(e.value)}</span>
                      </div>
                    </>
                  ) : (
                    <div className="history-entry__line">
                      <span className="history-entry__revert-badge">↩ reverted</span> by{' '}
                      <span className="history-entry__who">{fmtUser(e.actor)}</span> to{' '}
                      {fmtTime(e.target)}
                    </div>
                  )}
                  <div className="history-entry__time">{fmtTime(e.serverTs)}</div>
                </div>
                <button
                  className="history-entry__restore"
                  onClick={() => restore(e.serverTs)}
                  disabled={busyTs !== null}
                  title="Undo this change and everything after it"
                >
                  {busyTs === e.serverTs ? '…' : 'Undo from here'}
                </button>
              </li>
            ))}
          </ol>
        )}
      </aside>
    </div>
  )
}
