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
import { useEffect, useState } from 'react'
import { MarkdownEditor } from '@/views/entry/MarkdownEditor'
import { referenceLabel, type ReferenceLookup } from '@/lib/referenceLookup'
import './cells.css'

export interface CellColumn {
  id: string
  name: string
  column_type: string
  required?: boolean
  options?: string[]
  reference_table?: string
  /** Which column of `reference_table` labels a row (issue c14e01a0). */
  reference_display_column?: string
}

/** Resolve the selectable records of a referenced table (id + display label).
 *  Supplied by the consumer (grid / entry view) since only it has the
 *  workspace — see `lib/referenceLookup`. */
export type { ReferenceLookup }

/** The workspace room's members (id = MXID, label = display name), for
 *  `member` / `multimember` columns. Supplied by the consumer. */
export type MemberList = Array<{ id: string; label: string }>

export interface CellDisplayProps {
  column: CellColumn
  value: any
  lookup?: ReferenceLookup
  members?: MemberList
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
  /** Move edit focus to an adjacent cell after committing — Enter→down,
   *  Tab→right, Shift+Tab→left. When provided, editors call this instead of
   *  `onDone` on those keys so the grid can keep editing the next cell. */
  onNavigate?: (direction: 'up' | 'down' | 'left' | 'right') => void
  /** Resolve referenced records (used by `reference` columns). */
  lookup?: ReferenceLookup
  /** Room members (used by `member` / `multimember` columns). */
  members?: MemberList
  /** Render large editors (e.g. `document`) in a floating popover instead of
   *  inline, so they don't distend a grid cell. The entry/detail view leaves
   *  this off and edits inline. */
  popover?: boolean
}

// ── Display: compact, read-only rendering for a grid cell ──────────────────

function defaultText(value: any): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/** Display name for an MXID: the member's label, else the localpart. */
export function memberLabel(members: MemberList | undefined, mxid: string): string {
  const found = members?.find(m => m.id === mxid)
  if (found?.label) return found.label
  const m = /^@([^:]+):/.exec(mxid)
  return m ? m[1] : mxid
}

/** One referenced row as a pill. A row that no longer exists renders its raw
 *  id in a "dangling" style — a broken link should be visible, not blank. */
function referencePill(
  column: CellColumn,
  lookup: ReferenceLookup | undefined,
  id: string,
  tag = false,
) {
  const records =
    lookup && column.reference_table
      ? lookup(column.reference_table, column.reference_display_column)
      : null
  const { label, dangling } = referenceLabel(records, id)
  const base = tag ? 'cell-tag' : 'cell-pill'
  return (
    <span
      key={id}
      className={dangling ? `${base} cell-ref--dangling` : base}
      title={dangling ? `Referenced row ${id} no longer exists` : undefined}
    >
      {label}
    </span>
  )
}

export function CellDisplay({ column, value, lookup, members }: CellDisplayProps) {
  switch (column.column_type) {
    case 'member': {
      if (value == null || value === '') return <span className="cell-display" />
      const label = memberLabel(members, String(value))
      return (
        <span className="cell-display">
          <span className="cell-member-dot" aria-hidden="true">{label[0]?.toUpperCase() ?? '?'}</span>
          <span className="cell-pill">{label}</span>
        </span>
      )
    }
    case 'multimember': {
      const items = Array.isArray(value) ? value : value != null && value !== '' ? [value] : []
      return (
        <span className="cell-display cell-display--tags">
          {items.map((id: any) => (
            <span key={String(id)} className="cell-tag">{memberLabel(members, String(id))}</span>
          ))}
        </span>
      )
    }
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
    case 'document': {
      // One line only: newlines in the markdown would otherwise grow the cell
      // vertically, and the CSS clamp (cell-display--doc) clips the rest.
      const preview = defaultText(value).replace(/\s+/g, ' ').trim().slice(0, 120)
      return <span className="cell-display cell-display--muted cell-display--doc">{preview}</span>
    }
    case 'json':
      return <span className="cell-display cell-display--mono">{defaultText(value)}</span>
    case 'reference': {
      if (value == null || value === '') return <span className="cell-display" />
      return <span className="cell-display">{referencePill(column, lookup, String(value))}</span>
    }
    case 'multireference': {
      const items = Array.isArray(value) ? value : value != null && value !== '' ? [value] : []
      return (
        <span className="cell-display cell-display--tags">
          {items.map((id: any) => referencePill(column, lookup, String(id), true))}
        </span>
      )
    }
    case 'formula': {
      // Computed in app-core at read time, never stored. A formula that failed
      // renders its own error string (they all start with '#'), surfaced
      // distinctly — a blank would be indistinguishable from "no data", which
      // is exactly how a broken formula goes unnoticed.
      const text = defaultText(value)
      const failed = text.startsWith('#')
      return (
        <span
          className={`cell-display cell-display--computed${failed ? ' cell-display--formula-error' : ''}`}
          title={failed ? `This formula did not evaluate: ${text}` : undefined}
        >
          {text}
        </span>
      )
    }
    default:
      return <span className="cell-display">{defaultText(value)}</span>
  }
}

/** Column types whose value is derived, not entered. The grid must not open an
 *  editor on them: a computed cell has nowhere to write back to. */
export const COMPUTED_TYPES = new Set(['formula'])

export const isComputedColumn = (columnType: string) => COMPUTED_TYPES.has(columnType)

// ── Editors: commit on blur / Enter, one value per logical edit ────────────

/** Hook: local draft that resets when the upstream value changes. */
function useDraft<T>(value: T): [T, (v: T) => void] {
  const [draft, setDraft] = useState<T>(value)
  useEffect(() => setDraft(value), [value])
  return [draft, setDraft]
}

/** Shared key handling for text-like editors: Enter→commit+down,
 *  Tab/Shift+Tab→commit+right/left (so editing flows to the next cell), and
 *  Escape→cancel. `finish(nav)` commits the value, then navigates if a direction
 *  is given (else exits via onDone). Structurally typed so no React import. */
function handleEditKeys(
  e: { key: string; shiftKey: boolean; preventDefault: () => void },
  finish: (nav?: 'down' | 'left' | 'right') => void,
  onDone?: () => void,
) {
  if (e.key === 'Enter') { e.preventDefault(); finish('down') }
  else if (e.key === 'Tab') { e.preventDefault(); finish(e.shiftKey ? 'left' : 'right') }
  else if (e.key === 'Escape') onDone?.()
}

function TextEditor({ column, value, commit, autoFocus, onDone, onNavigate }: CellEditorProps) {
  const [draft, setDraft] = useDraft(value ?? '')
  const finish = (nav?: 'down' | 'left' | 'right') => {
    if (draft !== (value ?? '')) commit(draft)
    if (nav && onNavigate) onNavigate(nav)
    else onDone?.()
  }
  return (
    <input
      type="text"
      className="cell-input"
      value={draft as string}
      autoFocus={autoFocus}
      placeholder={`Enter ${column.name.toLowerCase()}…`}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => finish()}
      onKeyDown={e => handleEditKeys(e, finish, onDone)}
    />
  )
}

function NumberEditor({ value, commit, autoFocus, onDone, onNavigate }: CellEditorProps) {
  const [draft, setDraft] = useDraft(value ?? '')
  const finish = (nav?: 'down' | 'left' | 'right') => {
    const parsed = draft === '' || draft == null ? null : Number(draft)
    const next = parsed != null && !Number.isNaN(parsed) ? parsed : null
    if (next !== (value ?? null)) commit(next)
    if (nav && onNavigate) onNavigate(nav)
    else onDone?.()
  }
  return (
    <input
      type="number"
      className="cell-input cell-input--number"
      value={draft as any}
      autoFocus={autoFocus}
      onChange={e => setDraft(e.target.value as any)}
      onBlur={() => finish()}
      onKeyDown={e => handleEditKeys(e, finish, onDone)}
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

function DateEditor({ value, commit, autoFocus, onDone, onNavigate }: CellEditorProps) {
  const [draft, setDraft] = useDraft(value ?? '')
  const finish = (nav?: 'down' | 'left' | 'right') => {
    if (draft !== (value ?? '')) commit(draft)
    if (nav && onNavigate) onNavigate(nav)
    else onDone?.()
  }
  return (
    <input
      type="date"
      className="cell-input cell-input--date"
      value={draft as string}
      autoFocus={autoFocus}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => finish()}
      onKeyDown={e => handleEditKeys(e, finish, onDone)}
    />
  )
}

function SelectEditor({ column, value, commit, autoFocus, onDone, onNavigate }: CellEditorProps) {
  return (
    <select
      className="cell-input cell-input--select"
      value={value ?? ''}
      autoFocus={autoFocus}
      onChange={e => { commit(e.target.value === '' ? null : e.target.value); onDone?.() }}
      onBlur={onDone}
      onKeyDown={e => {
        // Native select handles Enter/arrows; only intercept Tab to flow to the
        // next cell instead of leaving the grid.
        if (e.key === 'Tab') {
          e.preventDefault()
          if (onNavigate) onNavigate(e.shiftKey ? 'left' : 'right')
          else onDone?.()
        }
      }}
    >
      <option value="">Select {column.name}...</option>
      {(column.options ?? []).map(opt => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
    </select>
  )
}

function MultiSelectEditor({ column, value, commit, autoFocus, onDone }: CellEditorProps) {
  const selected: string[] = Array.isArray(value)
    ? value.map(String)
    : value != null && value !== ''
      ? [String(value)]
      : []
  const [draft, setDraft] = useState('')

  const addTag = (raw: string) => {
    const tag = raw.trim()
    setDraft('')
    if (tag && !selected.includes(tag)) commit([...selected, tag])
  }
  const removeTag = (tag: string) => commit(selected.filter(t => t !== tag))

  const listId = `ms-${column.id}`
  const remaining = (column.options ?? []).filter(o => !selected.includes(o))

  return (
    <div className="cell-multiselect">
      {selected.map(tag => (
        <span key={tag} className="cell-tag cell-tag--editable">
          <span className="cell-tag__label">{tag}</span>
          <button
            type="button"
            className="cell-tag__remove"
            aria-label={`Remove ${tag}`}
            onClick={() => removeTag(tag)}
          >×</button>
        </span>
      ))}
      <input
        type="text"
        className="cell-multiselect__input"
        value={draft}
        autoFocus={autoFocus}
        placeholder="Add…"
        list={remaining.length ? listId : undefined}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { if (draft.trim()) addTag(draft); onDone?.() }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); addTag(draft) }
          else if (e.key === 'Backspace' && draft === '' && selected.length) removeTag(selected[selected.length - 1])
          else if (e.key === 'Escape') onDone?.()
        }}
      />
      {remaining.length > 0 && (
        <datalist id={listId}>
          {remaining.map(o => <option key={o} value={o} />)}
        </datalist>
      )}
    </div>
  )
}

function MemberEditor({ column, value, commit, autoFocus, onDone, members }: CellEditorProps) {
  return (
    <select
      className="cell-input cell-input--select"
      value={value ?? ''}
      autoFocus={autoFocus}
      onChange={e => { commit(e.target.value === '' ? null : e.target.value); onDone?.() }}
      onBlur={onDone}
    >
      <option value="">Assign {column.name}...</option>
      {(members ?? []).map(m => (
        <option key={m.id} value={m.id}>{m.label || m.id}</option>
      ))}
    </select>
  )
}

function MultiMemberEditor({ value, commit, autoFocus, onDone, members }: CellEditorProps) {
  const selected: string[] = Array.isArray(value) ? value.map(String) : []
  const remaining = (members ?? []).filter(m => !selected.includes(m.id))
  return (
    <div className="cell-multiselect">
      {selected.map(id => (
        <span key={id} className="cell-tag cell-tag--editable">
          <span className="cell-tag__label">{memberLabel(members, id)}</span>
          <button
            type="button"
            className="cell-tag__remove"
            aria-label={`Remove ${memberLabel(members, id)}`}
            onClick={() => commit(selected.filter(s => s !== id))}
          >×</button>
        </span>
      ))}
      <select
        className="cell-input cell-input--select"
        value=""
        autoFocus={autoFocus}
        onChange={e => { if (e.target.value) commit([...selected, e.target.value]) }}
        onBlur={onDone}
      >
        <option value="">Add member...</option>
        {remaining.map(m => (
          <option key={m.id} value={m.id}>{m.label || m.id}</option>
        ))}
      </select>
    </div>
  )
}

function ReferenceEditor({ column, value, commit, autoFocus, onDone, lookup }: CellEditorProps) {
  const records =
    lookup && column.reference_table
      ? lookup(column.reference_table, column.reference_display_column)
      : null
  // Hook must run unconditionally; only the fallback path uses the draft.
  const [draft, setDraft] = useDraft(value ?? '')

  if (records) {
    return (
      <select
        className="cell-input cell-input--select"
        value={value ?? ''}
        autoFocus={autoFocus}
        onChange={e => { commit(e.target.value === '' ? null : e.target.value); onDone?.() }}
        onBlur={onDone}
      >
        <option value="">Select {column.name}...</option>
        {records.map(r => (
          <option key={r.id} value={r.id}>{r.label || r.id}</option>
        ))}
      </select>
    )
  }

  // Fallback: plain id entry when no lookup is supplied.
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

function DocumentEditor({ column, value, commit, onDone, popover }: CellEditorProps) {
  // A controlled draft (not a ref) — binding MarkdownEditor's `value` to the
  // upstream value let only the first keystroke "stick"; the draft state lets
  // text accumulate normally.
  const [draft, setDraft] = useDraft<string>(value ?? '')
  const finish = () => {
    if (draft !== (value ?? '')) commit(draft)
    onDone?.()
  }

  const editor = (
    <MarkdownEditor
      value={draft}
      onChange={setDraft}
      autoFocus={popover}
      // In a popover we commit on close (Done / click-off), not on textarea
      // blur — otherwise toggling Preview would commit and dismiss.
      onBlur={popover ? undefined : finish}
    />
  )

  if (!popover) return editor

  return (
    <div className="doc-popover__overlay" onMouseDown={finish}>
      <div className="doc-popover" onMouseDown={e => e.stopPropagation()}>
        <div className="doc-popover__header">
          <span className="doc-popover__title">{column.name}</span>
          <button type="button" className="doc-popover__done" onClick={finish}>Done</button>
        </div>
        {editor}
      </div>
    </div>
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

/** Multi-reference: the same add/remove shape as MultiMemberEditor, over rows
 *  of the referenced table. */
function MultiReferenceEditor({ column, value, commit, autoFocus, onDone, lookup }: CellEditorProps) {
  const selected: string[] = Array.isArray(value) ? value.map(String) : []
  const records =
    (lookup && column.reference_table
      ? lookup(column.reference_table, column.reference_display_column)
      : null) ?? []
  const remaining = records.filter(r => !selected.includes(r.id))
  const labelOf = (id: string) => referenceLabel(records, id).label
  return (
    <div className="cell-multiselect">
      {selected.map(id => (
        <span key={id} className="cell-tag cell-tag--editable">
          <span className="cell-tag__label">{labelOf(id)}</span>
          <button
            type="button"
            className="cell-tag__remove"
            aria-label={`Remove ${labelOf(id)}`}
            onClick={() => commit(selected.filter(s => s !== id))}
          >×</button>
        </span>
      ))}
      <select
        className="cell-input cell-input--select"
        value=""
        autoFocus={autoFocus}
        onChange={e => { if (e.target.value) commit([...selected, e.target.value]) }}
        onBlur={onDone}
      >
        <option value="">Add {column.name}...</option>
        {remaining.map(r => (
          <option key={r.id} value={r.id}>{r.label}</option>
        ))}
      </select>
    </div>
  )
}

const EDITORS: Record<string, (p: CellEditorProps) => JSX.Element> = {
  text: TextEditor,
  number: NumberEditor,
  boolean: BooleanEditor,
  date: DateEditor,
  select: SelectEditor,
  multiselect: MultiSelectEditor,
  member: MemberEditor,
  multimember: MultiMemberEditor,
  reference: ReferenceEditor,
  multireference: MultiReferenceEditor,
  document: DocumentEditor,
  json: JsonEditor,
  formula: ComputedCell,
}

/** "Editor" for a computed column: shows the value and explains why it cannot
 *  be typed into. Registered so that even if some path opens an editor, there
 *  is no input that could commit over a derived value. */
function ComputedCell({ column, value }: CellEditorProps) {
  return (
    <div className="cell-editor cell-editor--computed" title={`${column.name} is computed by a formula`}>
      <span className="cell-display cell-display--computed">{defaultText(value)}</span>
    </div>
  )
}

/** Render the editor for a column's type (falls back to a text editor). */
export function CellEditor(props: CellEditorProps) {
  const Editor = EDITORS[props.column.column_type] ?? TextEditor
  return <Editor {...props} />
}

/** Column types whose editor commits on a single discrete interaction, so the
 *  grid can render them inline without a separate edit-mode click. */
export const INLINE_EDIT_TYPES = new Set(['boolean', 'select'])
