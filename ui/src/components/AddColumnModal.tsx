import { useState } from 'react'
import './AddColumnModal.css'

export type ColumnType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'document'

interface ColumnTypeMeta {
  type: ColumnType
  label: string
  description: string
}

const COLUMN_TYPES: ColumnTypeMeta[] = [
  { type: 'text',        label: 'Text',        description: 'Single-line or multi-line text'    },
  { type: 'number',      label: 'Number',       description: 'Integer or decimal value'          },
  { type: 'select',      label: 'Select',       description: 'Single-choice from a fixed list'   },
  { type: 'multiselect', label: 'Multi-select', description: 'Multiple choices from a list'      },
  { type: 'date',        label: 'Date',         description: 'Calendar date (YYYY-MM-DD)'         },
  { type: 'boolean',     label: 'Checkbox',     description: 'True / false toggle'               },
  { type: 'document',    label: 'Document',     description: 'Rich Markdown content field'       },
]

export interface NewColumnDef {
  name: string
  columnType: ColumnType
  options: string[]  // only used for select / multiselect
}

interface AddColumnModalProps {
  onAdd: (def: NewColumnDef) => Promise<void> | void
  onClose: () => void
}

export function AddColumnModal({ onAdd, onClose }: AddColumnModalProps) {
  const [name, setName] = useState('')
  const [columnType, setColumnType] = useState<ColumnType>('text')
  const [optionsRaw, setOptionsRaw] = useState('Option 1, Option 2, Option 3')
  const [adding, setAdding] = useState(false)

  const isSelectType = columnType === 'select' || columnType === 'multiselect'
  const canSubmit = name.trim().length > 0

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || adding) return
    const options = isSelectType
      ? optionsRaw.split(',').map(s => s.trim()).filter(s => s.length > 0)
      : []
    setAdding(true)
    try {
      await onAdd({ name: name.trim(), columnType, options })
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal acm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="acm__header">
          <h2 className="acm__title">Add column</h2>
          <button className="acm__close ghost" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Column name */}
          <div className="acm__form-group">
            <label className="acm__label">Column name</label>
            <input
              className="acm__input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Priority"
              autoFocus
            />
          </div>

          {/* Column type */}
          <div className="acm__form-group">
            <label className="acm__label">Column type</label>
            <div className="acm__type-list">
              {COLUMN_TYPES.map(ct => (
                <label
                  key={ct.type}
                  className={`acm__type-row ${columnType === ct.type ? 'acm__type-row--active' : ''}`}
                >
                  <input
                    type="radio"
                    name="column-type"
                    value={ct.type}
                    checked={columnType === ct.type}
                    onChange={() => setColumnType(ct.type)}
                    className="acm__type-radio"
                  />
                  <span className="acm__type-label">{ct.label}</span>
                  <span className="acm__type-desc">{ct.description}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Options — only for select / multiselect */}
          {isSelectType && (
            <div className="acm__form-group">
              <label className="acm__label">
                Options <span className="acm__label-hint">(comma-separated)</span>
              </label>
              <input
                className="acm__input"
                type="text"
                value={optionsRaw}
                onChange={e => setOptionsRaw(e.target.value)}
                placeholder="Todo, In Progress, Done"
              />
              {/* Preview pills */}
              <div className="acm__option-preview">
                {optionsRaw.split(',').map(s => s.trim()).filter(s => s).map(opt => (
                  <span key={opt} className="acm__option-chip">{opt}</span>
                ))}
              </div>
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={adding}>Cancel</button>
            <button type="submit" className="primary" disabled={!canSubmit || adding}>
              {adding ? 'Adding...' : 'Add column'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
