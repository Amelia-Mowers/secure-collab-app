import { useState, useEffect, useMemo } from 'react'
import './AddColumnModal.css'

export type ColumnType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'document'
  | 'member'
  | 'multimember'
  | 'reference'
  | 'multireference'
  | 'formula'

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
  { type: 'member',      label: 'Member',       description: 'A person from this workspace'      },
  { type: 'multimember', label: 'Members',      description: 'Several people from this workspace' },
  { type: 'reference',   label: 'Reference',    description: 'A row from another table'          },
  { type: 'multireference', label: 'References', description: 'Several rows from another table'  },
  { type: 'formula',     label: 'Formula',     description: 'Computed from this row’s other columns' },
]

/** A table this column could point at, with the columns that could label its
 *  rows. Supplied by the parent (only it can read the workspace schema). */
export interface ReferenceTarget {
  id: string
  name: string
  columns: Array<{ id: string; name: string; column_type: string }>
}

export interface NewColumnDef {
  name: string
  columnType: ColumnType
  options: string[]  // only used for select / multiselect
  /** Default value applied to new entries. Currently surfaced for `select`
   *  columns (defaults to the first option) so single-selects start on a value
   *  instead of blank. */
  defaultValue?: string
  /** reference / multireference: the table pointed at. */
  referenceTable?: string
  /** reference / multireference: which of its columns labels a row. Written
   *  explicitly at creation time rather than inferred later (issue c14e01a0). */
  referenceDisplayColumn?: string
  /** formula: the Typst expression, evaluated against each row at read time. */
  formula?: string
}

export interface EditColumnInitial {
  name: string
  columnType: ColumnType
  options: string[]
  defaultValue?: string
  referenceTable?: string
  referenceDisplayColumn?: string
  formula?: string
}

interface AddColumnModalProps {
  /** Submit handler. In edit mode the parent routes this to an update. */
  onAdd: (def: NewColumnDef) => Promise<void> | void
  onClose: () => void
  /** When present, the modal edits an existing column (prefilled, "Save"). */
  initial?: EditColumnInitial
  /** Distinct existing values of the column, used to auto-fill Select options
   *  when changing a column to select/multiselect (#6). */
  existingValues?: string[]
  /** Tables this column could reference. Empty (the default) hides the
   *  reference types — there is nothing to point at. */
  referenceTargets?: ReferenceTarget[]
}

export function AddColumnModal({
  onAdd,
  onClose,
  initial,
  existingValues,
  referenceTargets = [],
}: AddColumnModalProps) {
  const isEdit = !!initial
  const [name, setName] = useState(initial?.name ?? '')
  const [columnType, setColumnType] = useState<ColumnType>(initial?.columnType ?? 'text')
  const [optionsRaw, setOptionsRaw] = useState(
    initial?.options?.length ? initial.options.join(', ') : 'Option 1, Option 2, Option 3',
  )
  const [defaultValue, setDefaultValue] = useState(initial?.defaultValue ?? '')
  const [referenceTable, setReferenceTable] = useState(initial?.referenceTable ?? '')
  const [displayColumn, setDisplayColumn] = useState(initial?.referenceDisplayColumn ?? '')
  const [formula, setFormula] = useState(initial?.formula ?? '')
  const [adding, setAdding] = useState(false)

  const isSelectType = columnType === 'select' || columnType === 'multiselect'
  const isReferenceType = columnType === 'reference' || columnType === 'multireference'
  const isFormulaType = columnType === 'formula'
  // Nothing to point at → don't offer the reference types at all.
  const columnTypes = referenceTargets.length
    ? COLUMN_TYPES
    : COLUMN_TYPES.filter(ct => ct.type !== 'reference' && ct.type !== 'multireference')
  const target = referenceTargets.find(t => t.id === referenceTable)
  const canSubmit =
    name.trim().length > 0 &&
    (!isReferenceType || !!referenceTable) &&
    (!isFormulaType || formula.trim().length > 0)

  const options = useMemo(
    () => optionsRaw.split(',').map(s => s.trim()).filter(s => s.length > 0),
    [optionsRaw],
  )

  // A single-select defaults to its first option (the user's ask), but the
  // choice is editable here — including "(no default)". Keep the picked default
  // valid as options/type change; non-select types carry no default.
  useEffect(() => {
    if (columnType === 'select') {
      setDefaultValue(prev => (prev && options.includes(prev) ? prev : options[0] ?? ''))
    } else {
      setDefaultValue('')
    }
  }, [columnType, options])

  // Pick sane starting points for a reference column, but MATERIALIZE them into
  // the saved config — a display column that was merely inferred at read time
  // is a hidden rule nobody can change (see the `lean-on-view-settings` rule).
  useEffect(() => {
    if (!isReferenceType) return
    setReferenceTable(prev => (referenceTargets.some(t => t.id === prev) ? prev : referenceTargets[0]?.id ?? ''))
  }, [isReferenceType, referenceTargets])
  useEffect(() => {
    if (!isReferenceType || !target) return
    setDisplayColumn(prev =>
      target.columns.some(c => c.id === prev)
        ? prev
        : target.columns.find(c => c.column_type === 'text')?.id ?? target.columns[0]?.id ?? '',
    )
  }, [isReferenceType, target])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit || adding) return
    setAdding(true)
    try {
      await onAdd({
        name: name.trim(),
        columnType,
        options: isSelectType ? options : [],
        defaultValue: columnType === 'select' && defaultValue ? defaultValue : undefined,
        referenceTable: isReferenceType ? referenceTable : undefined,
        referenceDisplayColumn: isReferenceType && displayColumn ? displayColumn : undefined,
        formula: isFormulaType ? formula.trim() : undefined,
      })
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal acm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="acm__header">
          <h2 className="acm__title">{isEdit ? 'Edit column' : 'Add column'}</h2>
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
              {columnTypes.map(ct => (
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
              {existingValues && existingValues.length > 0 && (
                <button
                  type="button"
                  className="ghost acm__autodetect"
                  onClick={() => setOptionsRaw(existingValues.join(', '))}
                >
                  Auto-detect from data ({existingValues.length} value{existingValues.length === 1 ? '' : 's'})
                </button>
              )}
              {/* Preview pills */}
              <div className="acm__option-preview">
                {options.map(opt => (
                  <span key={opt} className="acm__option-chip">{opt}</span>
                ))}
              </div>
            </div>
          )}

          {/* Reference target + the column that labels a referenced row */}
          {isReferenceType && (
            <>
              <div className="acm__form-group">
                <label className="acm__label" htmlFor="acm-ref-table">Referenced table</label>
                <select
                  id="acm-ref-table"
                  className="acm__input"
                  value={referenceTable}
                  onChange={e => setReferenceTable(e.target.value)}
                >
                  {referenceTargets.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div className="acm__form-group">
                <label className="acm__label" htmlFor="acm-ref-display">
                  Display column <span className="acm__label-hint">(what a linked row shows as)</span>
                </label>
                <select
                  id="acm-ref-display"
                  className="acm__input"
                  value={displayColumn}
                  onChange={e => setDisplayColumn(e.target.value)}
                  disabled={!target}
                >
                  {(target?.columns ?? []).map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          {/* Formula: a Typst expression over this row's other columns. Never
              stored — recomputed each time a row is read. */}
          {isFormulaType && (
            <div className="acm__form-group">
              <label className="acm__label" htmlFor="acm-formula">
                Formula <span className="acm__label-hint">(refer to columns by name)</span>
              </label>
              <input
                id="acm-formula"
                className="acm__input acm__input--mono"
                value={formula}
                onChange={e => setFormula(e.target.value)}
                placeholder={'join(" ", First Name, Last Name)'}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="acm__hint">
                Computed from each row, never stored. <code>+</code> joins text and adds
                numbers; <code>join(sep, …)</code> skips empty values, so a missing middle
                name leaves no double space. Also available: <code>upper</code>,{' '}
                <code>lower</code>, <code>trim</code>, <code>len</code>, and{' '}
                <code>if … else</code>.
              </p>
            </div>
          )}

          {/* Default value — single-select starts on a value instead of blank */}
          {columnType === 'select' && options.length > 0 && (
            <div className="acm__form-group">
              <label className="acm__label">
                Default value <span className="acm__label-hint">(new entries)</span>
              </label>
              <select
                className="acm__input"
                value={defaultValue}
                onChange={e => setDefaultValue(e.target.value)}
              >
                <option value="">(no default)</option>
                {options.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={adding}>Cancel</button>
            <button type="submit" className="primary" disabled={!canSubmit || adding}>
              {adding
                ? (isEdit ? 'Saving…' : 'Adding...')
                : (isEdit ? 'Save changes' : 'Add column')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
