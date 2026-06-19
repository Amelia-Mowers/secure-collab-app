import { useState } from 'react'
import { TABLE_TEMPLATES, type TableTemplate } from '@/tableTemplates'
import './AddColumnModal.css'

interface NewTableModalProps {
  onCreate: (name: string, template: TableTemplate) => Promise<void> | void
  onClose: () => void
  creating?: boolean
}

/** Create-a-table modal with a starter-template picker (#3). Defaults to the
 *  "Blank" template, and Enter submits — so the original "name + Enter" flow
 *  still works, with templates as opt-in. */
export function NewTableModal({ onCreate, onClose, creating }: NewTableModalProps) {
  const [name, setName] = useState('')
  const [templateId, setTemplateId] = useState('blank')

  const template = TABLE_TEMPLATES.find(t => t.id === templateId) ?? TABLE_TEMPLATES[0]
  const canSubmit = name.trim().length > 0

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || creating) return
    onCreate(name.trim(), template)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal acm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="acm__header">
          <h2 className="acm__title">New table</h2>
          <button className="acm__close ghost" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form onSubmit={submit}>
          <div className="acm__form-group">
            <label className="acm__label">Table name</label>
            <input
              className="acm__input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Table name..."
              autoFocus
              disabled={creating}
            />
          </div>

          <div className="acm__form-group">
            <label className="acm__label">Start from</label>
            <div className="acm__type-list">
              {TABLE_TEMPLATES.map(t => (
                <label
                  key={t.id}
                  className={`acm__type-row ${templateId === t.id ? 'acm__type-row--active' : ''}`}
                >
                  <input
                    type="radio"
                    name="table-template"
                    value={t.id}
                    checked={templateId === t.id}
                    onChange={() => setTemplateId(t.id)}
                    className="acm__type-radio"
                  />
                  <span className="acm__type-label">{t.label}</span>
                  <span className="acm__type-desc">{t.description}</span>
                </label>
              ))}
            </div>
            {template.id !== 'blank' && (
              <div className="acm__option-preview">
                {template.columns.map(c => (
                  <span key={c.id} className="acm__option-chip">{c.name}</span>
                ))}
              </div>
            )}
          </div>

          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={creating}>Cancel</button>
            <button type="submit" className="primary" disabled={!canSubmit || creating}>
              {creating ? 'Creating…' : 'Create table'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
