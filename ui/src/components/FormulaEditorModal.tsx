import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import './FormulaEditorModal.css'

/** How many rows the preview evaluates. Enough to see a pattern, few enough
 *  that it stays instant while typing. */
const PREVIEW_ROWS = 6

/** Bare identifiers only — what the formula language accepts as a reference. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * How to refer to a column in a formula.
 *
 * The evaluator resolves a reference as an IDENTIFIER — by column id first,
 * then by display name — so a name with a space cannot be written at all.
 * Quoting it does not help and is actively worse: `"Last name"` parses as a
 * string literal, so the formula silently computes the words "Last name" for
 * every row instead of failing. The id is identifier-shaped, so that is what
 * gets inserted when the name is not usable.
 */
export function referenceToken(column: FormulaEditorColumn): string {
  if (IDENTIFIER.test(column.name)) return column.name
  return column.id
}

/** Can this column be referred to at all? Ids are slugified from the name, so
 *  a name like `2024 Total` yields `2024_total` — which no identifier may
 *  start with. Rare, but the alternative is a chip that inserts something the
 *  evaluator rejects with no hint as to why. */
export function isReferable(column: FormulaEditorColumn): boolean {
  return IDENTIFIER.test(referenceToken(column))
}

export interface FormulaPreviewRow {
  label: string
  value: string
  error: string | null
}

export interface FormulaEditorColumn {
  id: string
  name: string
  column_type: string
  /** The expression as saved. Absent on a column that has never had one. */
  formula?: string
}

export interface FormulaEditorModalProps {
  /** The formula column being edited. */
  column: FormulaEditorColumn
  /** Every column in the table, for the insert-a-name list. */
  columns: FormulaEditorColumn[]
  /** Evaluate against real rows without saving. Returns the bridge's JSON. */
  preview: (formula: string) => Promise<{ rows: FormulaPreviewRow[]; totalRows: number }>
  onSave: (formula: string) => void
  onClose: () => void
  /** Viewers may read the formula and change nothing. */
  readOnly?: boolean
}

/**
 * Edit a formula from the cell it produces.
 *
 * Before this, changing a formula meant finding the column header, opening its
 * menu, and editing a single-line field in the column-settings modal — three
 * steps away from the wrong answer you were looking at, with no way to see
 * whether the new formula was right until you saved it over every row.
 *
 * So: opened by clicking the cell, and it evaluates against real rows as you
 * type. Nothing is written until Save, and the preview is read-only on the core
 * side, so typing here cannot touch the table.
 */
export function FormulaEditorModal({
  column,
  columns,
  preview,
  onSave,
  onClose,
  readOnly = false,
}: FormulaEditorModalProps) {
  const [formula, setFormula] = useState('')
  const [rows, setRows] = useState<FormulaPreviewRow[]>([])
  const [totalRows, setTotalRows] = useState(0)
  const [syntaxError, setSyntaxError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const initial = useRef('')

  useEffect(() => {
    const current = column.formula ?? ''
    setFormula(current)
    initial.current = current
    inputRef.current?.focus()
  }, [column])

  // Re-evaluate as the formula changes. Debounced so a fast typist does not
  // queue an evaluation per keystroke over the whole preview set.
  useEffect(() => {
    let cancelled = false
    const handle = setTimeout(() => {
      if (!formula.trim()) {
        setRows([])
        setSyntaxError(null)
        return
      }
      preview(formula)
        .then(result => {
          if (cancelled) return
          setRows(result.rows)
          setTotalRows(result.totalRows)
          // An error on EVERY row is a broken formula, not bad data — say so
          // once at the top instead of repeating it down the list.
          const errors = result.rows.filter(r => r.error)
          setSyntaxError(
            result.rows.length > 0 && errors.length === result.rows.length
              ? errors[0].error
              : null,
          )
        })
        .catch(err => {
          if (cancelled) return
          setRows([])
          setSyntaxError(err instanceof Error ? err.message : String(err))
        })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [formula, preview])

  /** Columns a formula can refer to: everything except the one being computed,
   *  which cannot refer to itself. */
  const referable = useMemo(
    () => columns.filter(c => c.id !== column.id && isReferable(c)),
    [columns, column.id],
  )

  const insertColumn = (c: FormulaEditorColumn) => {
    const el = inputRef.current
    const token = referenceToken(c)
    if (!el) {
      setFormula(f => f + token)
      return
    }
    const start = el.selectionStart ?? formula.length
    const end = el.selectionEnd ?? formula.length
    setFormula(formula.slice(0, start) + token + formula.slice(end))
    // Put the caret after what we just inserted rather than at the end, so
    // inserting mid-expression does not jump the user to the end of the line.
    requestAnimationFrame(() => {
      el.focus()
      const at = start + token.length
      el.setSelectionRange(at, at)
    })
  }

  const dirty = formula !== initial.current
  const canSave = !readOnly && dirty && formula.trim().length > 0 && !syntaxError

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
    // Enter inserts a newline in a textarea; the formula is one expression, so
    // Enter should commit and Shift+Enter should be the escape hatch.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSave) onSave(formula.trim())
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal fx"
        role="dialog"
        aria-modal="true"
        aria-label={`Formula for ${column.name}`}
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <h2 className="fx__title">
          Formula <span className="fx__title-column">{column.name}</span>
        </h2>

        <textarea
          ref={inputRef}
          className="fx__input"
          value={formula}
          onChange={e => setFormula(e.target.value)}
          placeholder={'join(" ", First Name, Last Name)'}
          spellCheck={false}
          autoComplete="off"
          rows={2}
          readOnly={readOnly}
          aria-label="Formula"
          aria-invalid={!!syntaxError}
        />

        {syntaxError && (
          <p className="fx__error" role="alert">
            {syntaxError}
          </p>
        )}

        {referable.length > 0 && !readOnly && (
          <div className="fx__columns">
            <span className="fx__columns-label">Insert:</span>
            {referable.map(c => (
              <button
                key={c.id}
                type="button"
                className="fx__chip"
                // The token differs from the label whenever the display name is
                // not identifier-shaped, so say which one lands in the formula.
                title={`Insert ${referenceToken(c)}`}
                onClick={() => insertColumn(c)}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        <div className="fx__preview">
          <div className="fx__preview-head">
            Preview
            {totalRows > rows.length && (
              <span className="fx__preview-count">
                first {rows.length} of {totalRows} rows
              </span>
            )}
          </div>
          {rows.length === 0 ? (
            <p className="fx__preview-empty">
              {formula.trim() ? 'No rows to preview yet.' : 'Type a formula to see it evaluated.'}
            </p>
          ) : (
            <table className="fx__table">
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <th scope="row" className="fx__row-label">{r.label}</th>
                    <td className={`fx__row-value${r.error ? ' fx__row-value--error' : ''}`}>
                      {r.error ?? r.value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p className="fx__hint">
          Computed from each row, never stored. <code>+</code> joins text and adds
          numbers; <code>join(sep, …)</code> skips empty values. Also{' '}
          <code>upper</code>, <code>lower</code>, <code>trim</code>, <code>len</code>,
          and <code>if … else</code>.
        </p>

        <div className="fx__actions">
          <button type="button" className="fx__btn" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {!readOnly && (
            <button
              type="button"
              className="fx__btn fx__btn--primary"
              disabled={!canSave}
              onClick={() => onSave(formula.trim())}
            >
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export { PREVIEW_ROWS }
