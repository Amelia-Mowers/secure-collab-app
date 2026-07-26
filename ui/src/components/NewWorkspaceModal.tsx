import { useState } from 'react'
import type { WorkspaceTemplate } from '@/lib/workspaceTemplates'
import './AddColumnModal.css'

/**
 * Create-a-workspace dialogue with a starter picker (issue row_1785004738121).
 *
 * Everything you can start from lives in one list, because from here they are
 * the same kind of choice: nothing, one of the templates we ship, or an
 * archive someone exported — which is just a template somebody else made.
 *
 * Note what is NOT here: importing an archive into an *existing* workspace. An
 * archive describes a whole workspace — its name, tables, and views — so
 * merging one into a workspace that already has its own has no obvious right
 * answer. Creating is the honest scope, so it is the only one offered.
 */

export const EMPTY_OPTION = ''
export const ARCHIVE_OPTION = '__archive__'

export function NewWorkspaceModal({
  templates,
  onCreate,
  onClose,
  creating,
}: {
  templates: WorkspaceTemplate[]
  /** `archive` is set only for the "from an archive" choice. */
  onCreate: (name: string, slug: string, archive: File | null) => Promise<void> | void
  onClose: () => void
  creating?: boolean
}) {
  const [name, setName] = useState('')
  const [choice, setChoice] = useState(EMPTY_OPTION)
  const [archive, setArchive] = useState<File | null>(null)

  const needsArchive = choice === ARCHIVE_OPTION
  const canSubmit = name.trim().length > 0 && (!needsArchive || !!archive)
  const selected = templates.find(t => t.slug === choice)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || creating) return
    void onCreate(name.trim(), choice, needsArchive ? archive : null)
  }

  const pickArchive = (file: File | null) => {
    setArchive(file)
    // Name it after the file unless the user already typed something, so the
    // common case is one click and Create.
    if (file && !name.trim()) setName(file.name.replace(/\.zip$/i, ''))
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal acm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="acm__header">
          <h2 className="acm__title">New workspace</h2>
          <button className="acm__close ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="acm__form-group">
            <label className="acm__label">Workspace name</label>
            <input
              className="acm__input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Workspace name"
              autoFocus
              disabled={creating}
            />
          </div>

          <div className="acm__form-group">
            <label className="acm__label">Start from</label>
            <div className="acm__type-list">
              <label
                className={`acm__type-row ${choice === EMPTY_OPTION ? 'acm__type-row--active' : ''}`}
              >
                <input
                  type="radio"
                  name="workspace-template"
                  value={EMPTY_OPTION}
                  checked={choice === EMPTY_OPTION}
                  onChange={() => setChoice(EMPTY_OPTION)}
                  className="acm__type-radio"
                />
                <span className="acm__type-label">Empty</span>
                <span className="acm__type-desc">Start with nothing and add your own tables.</span>
              </label>

              {templates.map(t => (
                <label
                  key={t.slug}
                  className={`acm__type-row ${choice === t.slug ? 'acm__type-row--active' : ''}`}
                >
                  <input
                    type="radio"
                    name="workspace-template"
                    value={t.slug}
                    checked={choice === t.slug}
                    onChange={() => setChoice(t.slug)}
                    className="acm__type-radio"
                  />
                  <span className="acm__type-label">{t.name}</span>
                  <span className="acm__type-desc">{t.description}</span>
                </label>
              ))}

              <label
                className={`acm__type-row ${needsArchive ? 'acm__type-row--active' : ''}`}
              >
                <input
                  type="radio"
                  name="workspace-template"
                  value={ARCHIVE_OPTION}
                  checked={needsArchive}
                  onChange={() => setChoice(ARCHIVE_OPTION)}
                  className="acm__type-radio"
                />
                <span className="acm__type-label">From an archive</span>
                <span className="acm__type-desc">
                  A .zip exported from TideWork or written by the CLI. Ids are re-minted, so this
                  makes a copy rather than restoring the original.
                </span>
              </label>
            </div>

            {needsArchive && (
              <div className="acm__option-preview">
                <input
                  type="file"
                  accept=".zip,application/zip"
                  aria-label="Workspace archive"
                  disabled={creating}
                  onChange={e => pickArchive(e.target.files?.[0] ?? null)}
                />
              </div>
            )}

            {selected && selected.tables.length > 0 && (
              <div className="acm__option-preview">
                {selected.tables.map(t => (
                  <span key={t.id} className="acm__option-chip">
                    {t.name}
                    {t.rows > 0 ? ` · ${t.rows} rows` : ''}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={creating}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!canSubmit || creating}>
              {creating ? 'Creating…' : 'Create workspace'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
