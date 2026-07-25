import { useMemo, useState } from 'react'
import { ROLE_LABELS, type WorkspaceMember, type Role } from '@/lib/roles'
import './LeaveWorkspaceModal.css'

/**
 * Leaving — and its bigger sibling, deleting.
 *
 * Matrix has no delete-a-room operation: a room exists as long as any member
 * remains, so a client can only ever remove it from YOUR account, or evict
 * everyone and abandon it. The two live behind one checkbox rather than two
 * buttons, because they're the same action at different scope, and pretending
 * "Delete" erases the data everywhere would be a lie.
 *
 * The one rule worth enforcing: don't strand a workspace. A last admin can't
 * walk out and leave others with nobody able to manage members — so they must
 * appoint a successor first. Leaving as the last member is exempt: there's
 * nobody to strand, and forgetting the room lets the server reclaim it.
 */
export function LeaveWorkspaceModal({
  workspaceName,
  members,
  myUserId,
  myRole,
  onLeave,
  onPromote,
  onClose,
}: {
  workspaceName: string
  members: WorkspaceMember[]
  myUserId: string | null
  myRole: Role
  /** `removeEveryone` is the delete variant. */
  onLeave: (removeEveryone: boolean) => Promise<void>
  onPromote: (userId: string) => Promise<void>
  onClose: () => void
}) {
  const [removeEveryone, setRemoveEveryone] = useState(false)
  const [successor, setSuccessor] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const others = useMemo(() => members.filter(m => m.id !== myUserId), [members, myUserId])
  const isLastMember = others.length === 0
  const anotherAdmin = others.some(m => m.role === 'admin')
  /** Only blocks a plain leave: deleting removes everyone anyway. */
  const needsSuccessor = myRole === 'admin' && !isLastMember && !anotherAdmin && !removeEveryone
  const canConfirm = !busy && (!needsSuccessor || !!successor)

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      if (needsSuccessor && successor) await onPromote(successor)
      await onLeave(removeEveryone)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal lwm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 className="lwm__title">
          {removeEveryone ? 'Delete' : 'Leave'} “{workspaceName}”
        </h2>

        <p className="lwm__msg">
          {removeEveryone ? (
            <>
              Everyone will be removed and the workspace will become unreachable. This can&apos;t be
              undone — nobody, including you, will be able to open it again.
            </>
          ) : isLastMember ? (
            <>
              You&apos;re the last member, so this workspace will be left empty and its data
              eventually cleared from the server.
            </>
          ) : (
            <>
              It will be removed from your account. Other members keep theirs, and they can invite
              you back.
            </>
          )}
        </p>

        {myRole === 'admin' && !isLastMember && (
          <label className="lwm__toggle">
            <input
              type="checkbox"
              checked={removeEveryone}
              onChange={e => setRemoveEveryone(e.target.checked)}
            />
            Also remove everyone else — delete this workspace for all members
          </label>
        )}

        {needsSuccessor && (
          <div className="lwm__successor">
            <p className="lwm__msg">
              You&apos;re the only admin. Choose who takes over before you go:
            </p>
            <select
              className="lwm__select"
              value={successor}
              aria-label="New admin"
              onChange={e => setSuccessor(e.target.value)}
            >
              <option value="">Choose a member…</option>
              {others.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id} ({ROLE_LABELS[m.role]})
                </option>
              ))}
            </select>
          </div>
        )}

        {error && <p className="lwm__error" role="alert">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={removeEveryone ? 'lwm__danger' : 'primary'}
            onClick={() => void confirm()}
            disabled={!canConfirm}
          >
            {busy
              ? 'Working…'
              : removeEveryone
                ? 'Delete workspace'
                : 'Leave workspace'}
          </button>
        </div>
      </div>
    </div>
  )
}
