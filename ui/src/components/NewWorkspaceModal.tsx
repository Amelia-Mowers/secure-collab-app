import { useState } from 'react'
import type { WorkspaceTemplate } from '@/lib/workspaceTemplates'
import './AddColumnModal.css'
import './NewWorkspaceModal.css'

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
            <div className="nwm__list">
              <Tile
                value={EMPTY_OPTION}
                checked={choice === EMPTY_OPTION}
                onSelect={setChoice}
                name="Empty"
                description="Start with nothing and add your own tables."
              />

              {templates.map(t => (
                <Tile
                  key={t.slug}
                  value={t.slug}
                  checked={choice === t.slug}
                  onSelect={setChoice}
                  name={t.name}
                  description={t.description}
                >
                  {choice === t.slug && t.tables.length > 0 && (
                    <div className="nwm__detail">
                      {t.tables.map(tbl => (
                        <span key={tbl.id} className="nwm__chip">
                          {tbl.name}
                          {tbl.rows > 0 ? ` · ${tbl.rows} rows` : ''}
                        </span>
                      ))}
                    </div>
                  )}
                </Tile>
              ))}

              <Tile
                value={ARCHIVE_OPTION}
                checked={needsArchive}
                onSelect={setChoice}
                name="From an archive"
                description="A .zip exported from TideWork or written by the CLI. Ids are re-minted, so this makes a copy rather than restoring the original."
              >
                {needsArchive && (
                  <div className="nwm__file">
                    <input
                      type="file"
                      accept=".zip,application/zip"
                      aria-label="Workspace archive"
                      disabled={creating}
                      onChange={e => pickArchive(e.target.files?.[0] ?? null)}
                    />
                  </div>
                )}
              </Tile>
            </div>
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

/** One choice in the picker: a large clickable tile with its description, not
 *  a bare radio — the description is what makes the choice meaningful. */
function Tile({
  value,
  checked,
  onSelect,
  name,
  description,
  children,
}: {
  value: string
  checked: boolean
  onSelect: (value: string) => void
  name: string
  description: string
  children?: React.ReactNode
}) {
  return (
    <label className={`nwm__tile ${checked ? 'nwm__tile--active' : ''}`}>
      <input
        type="radio"
        name="workspace-template"
        className="nwm__radio"
        value={value}
        checked={checked}
        onChange={() => onSelect(value)}
      />
      <span className="nwm__name">{name}</span>
      <span className="nwm__desc">{description}</span>
      {children}
    </label>
  )
}
