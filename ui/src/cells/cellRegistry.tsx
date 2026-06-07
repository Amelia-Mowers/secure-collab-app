/**
 * Typed cell registry — one place that maps a column's `column_type` to how it
 * is displayed (compact, read-only) and edited (commit-on-blur/Enter).
 *
 * Used by BOTH the table grid and the entry/detail view, so per-type rendering
 * lives in exactly one place (previously duplicated between TableView's inline
 * inputs and FieldRenderer). See ARCHITECTURE_REVIEW.md / TODO.md (FE).
 *
 * Editors commit a single value per logical edit (on blur, Enter, or a discrete
 * change for select/boolean) — never per keystroke — so each edit maps to one
 * `updateCell` / `CellUpdate`.
 */
import { useEffect, useRef, useState } from 'react'
import { MarkdownEditor } from '@/views/entry/MarkdownEditor'

export interface CellColumn {
  id: string
  name: string
  column_type: string
  required?: boolean
  options?: string[]
  reference_table?: string
}

export interface CellDisplayProps {
  column: CellColumn
  value: any
}

export interface CellEditorProps {
  column: CellColumn
  value: any
  /** Commit a finalized value (one logical edit = one call). */
  commit: (value: any) => void
  /** Focus the editor on mount (grid: when a cell enters edit mode). */
  autoFocus?: boolean
  /** Editing finished (commit already fired if the value changed). */
  onDone?: () => void
}

// ── Display: compact, read-only rendering for a grid cell ──────────────────

function defaultText(value: any): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

export function CellDisplay({ column, value }: CellDisplayProps) {
  switch (column.column_type) {
    case 'boolean':
      return <span className="cell-display cell-display--bool">{value ? '✓' : ''}</span>
    case 'multiselect': {
      const items = Array.isArray(value) ? value : value != null ? [value] : []
      return (
        <span className="cell-display cell-display--tags">
          {items.map((t: any) => (
            <span key={String(t)} className="cell-tag">{String(t)}</span>
          ))}
        </span>
      )
    }
    case 'select':
      return value ? <span className="cell-display cell-pill">{String(value)}</span> : <span className="cell-display" />
    case 'document':
      return <span className="cell-display cell-display--muted">{defaultText(value).slice(0, 80)}</span>
    case 'json':
      return <span className="cell-display cell-display--mono">{defaultText(value)}</span>
    default:
      return <span className="cell-display">{defaultText(value)}</span>
  }
}

// ── Editors: commit on blur / Enter, one value per logical edit ────────────

/** Hook: local draft that resets when the upstream value changes. */
function useDraft<T>(value: T): [T, (v: T) => void] {
  const [draft, setDraft] = useState<T>(value)
  useEffect(() => setDraft(value), [value])
  return [draft, setDraft]
}

function TextEditor({ column, value, commit, autoFocus, onDone }: CellEditorProps) {
  const [draft, setDraft] = useDraft(value ?? '')
  const finish = () => {
    if (draft !== (value ?? '')) commit(draft)
    onDone?.()
  }
  return (
    <input
      type="text"
      className="cell-input"
      value={draft as string}
      autoFocus={autoFocus}
      placeholder={`Enter ${column.name.toLowerCase()}…`}
      onChange={e => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); finish() }
        if (e.key === 'Escape') onDone?.()
      }}
    />
  )
}

function NumberEditor({ value, commit, autoFocus, onDone }: CellEditorProps) {
  const [draft, setDraft] = useDraft(value ?? '')
  const finish = () => {
    const parsed = draft === '' || draft == null ? null : Number(draft)
    const next = parsed != null && !Number.isNaN(parsed) ? parsed : null
    if (next !== (value ?? null)) commit(next)
    onDone?.()
  }
  return (
    <input
      type="number"
      className="cell-input cell-input--number"
      value={draft as any}
      autoFocus={autoFocus}
      onChange={e => setDraft(e.target.value as any)}
      onBlur={finish}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); finish() }
        if (e.key === 'Escape') onDone?.()
      }}
    />
  )
}

function BooleanEditor({ column, value, commit, onDone }: CellEditorProps) {
  // Discrete: commit immediately on toggle.
  return (
    <label className="cell-checkbox">
      <input
        type="checkbox"
        checked={!!value}
        onChange={e => { commit(e.target.checked); onDone?.() }}
      />
      <span>{column.name}</span>
    </label>
  )
}

function DateEditor({ value, commit, autoFocus, onDone }: CellEditorProps) {
  const [draft, setDraft] = useDraft(value ?? '')
  const finish = () => {
    if (draft !== (value ?? '')) commit(draft)
    onDone?.()
  }
  return (
    <input
      type="date"
      className="cell-input cell-input--date"
      value={draft as string}
      autoFocus={autoFocus}
      onChange={e => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={e => { if (e.key === 'Escape') onDone?.() }}
    />
  )
}

function SelectEditor({ column, value, commit, autoFocus, onDone }: CellEditorProps) {
  return (
    <select
      className="cell-input cell-input--select"
      value={value ?? ''}
      autoFocus={autoFocus}
      onChange={e => { commit(e.target.value === '' ? null : e.target.value); onDone?.() }}
      onBlur={onDone}
    >
      <option value="">—</option>
      {(column.options ?? []).map(opt => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
    </select>
  )
}

function MultiSelectEditor({ value, commit, autoFocus, onDone }: CellEditorProps) {
  // Simple comma-separated tag editing for now (a real tag picker is a follow-up).
  const initial = Array.isArray(value) ? value.join(', ') : (value ?? '')
  const [draft, setDraft] = useDraft(initial)
  const finish = () => {
    const next = (draft as string)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    commit(next)
    onDone?.()
  }
  return (
    <input
      type="text"
      className="cell-input"
      value={draft as string}
      autoFocus={autoFocus}
      placeholder="Comma-separated values…"
      onChange={e => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); finish() }
        if (e.key === 'Escape') onDone?.()
      }}
    />
  )
}

function ReferenceEditor({ column, value, commit, autoFocus, onDone }: CellEditorProps) {
  // Plain id entry for now (a real record picker is a follow-up).
  const [draft, setDraft] = useDraft(value ?? '')
  const finish = () => {
    if (draft !== (value ?? '')) commit(draft)
    onDone?.()
  }
  return (
    <input
      type="text"
      className="cell-input"
      value={draft as string}
      autoFocus={autoFocus}
      placeholder={`Reference to ${column.reference_table || 'another table'}…`}
      onChange={e => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); finish() }
        if (e.key === 'Escape') onDone?.()
      }}
    />
  )
}

function DocumentEditor({ value, commit, onDone }: CellEditorProps) {
  const draftRef = useRef<string>(value ?? '')
  return (
    <MarkdownEditor
      value={value ?? ''}
      onChange={(v: string) => { draftRef.current = v }}
      onBlur={() => { if (draftRef.current !== (value ?? '')) commit(draftRef.current); onDone?.() }}
      onFocus={() => {}}
    />
  )
}

function JsonEditor({ value, commit, autoFocus, onDone }: CellEditorProps) {
  const initial = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)
  const [draft, setDraft] = useDraft(initial)
  const finish = () => {
    try {
      commit(JSON.parse(draft as string))
    } catch {
      // Keep the raw string if it isn't valid JSON yet.
      commit(draft)
    }
    onDone?.()
  }
  return (
    <textarea
      className="cell-input cell-input--json"
      rows={8}
      value={draft as string}
      autoFocus={autoFocus}
      onChange={e => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={e => { if (e.key === 'Escape') onDone?.() }}
    />
  )
}

const EDITORS: Record<string, (p: CellEditorProps) => JSX.Element> = {
  text: TextEditor,
  number: NumberEditor,
  boolean: BooleanEditor,
  date: DateEditor,
  select: SelectEditor,
  multiselect: MultiSelectEditor,
  reference: ReferenceEditor,
  document: DocumentEditor,
  json: JsonEditor,
}

/** Render the editor for a column's type (falls back to a text editor). */
export function CellEditor(props: CellEditorProps) {
  const Editor = EDITORS[props.column.column_type] ?? TextEditor
  return <Editor {...props} />
}

/** Column types whose editor commits on a single discrete interaction, so the
 *  grid can render them inline without a separate edit-mode click. */
export const INLINE_EDIT_TYPES = new Set(['boolean', 'select'])
