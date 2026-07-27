import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './CsvImportModal.css'

/**
 * Import a CSV (ADR 0004).
 *
 * The whole point of this dialogue is the step between "pick a file" and "it's
 * in your table": type inference is a *starting point*, not a silent decision,
 * so every inferred type is shown and overridable, and the dry run's failures
 * are counted on screen before anything is committed. An import that quietly
 * dropped a column's worth of values would look identical to a clean one.
 *
 * Destination is either a new table or an existing one. Appending matches
 * headers to the live columns by name and the live definition wins on type —
 * which is why matched columns render as locked rather than as a control that
 * looks editable but isn't respected.
 */

export interface CsvPreviewColumn {
  id: string
  name: string
  type: string
  options?: string[] | null
  /** Matched a column already in the destination table. */
  existing: boolean
}

export interface CsvIssue {
  row: number
  column: string
  message: string
}

interface CsvPreview {
  columns: CsvPreviewColumn[]
  rows: string[][]
  totalRows: number
  issues: CsvIssue[]
}

export interface CsvImportTarget {
  id: string
  name: string
}

/** Types a user can pick in the preview. Reference types are deliberately
 *  absent: they need a target table and display column, which is a schema
 *  decision rather than an import one — a matched existing reference column
 *  still works, it just isn't something you choose here. */
const CHOOSABLE_TYPES = [
  ['text', 'Text'],
  ['number', 'Number'],
  ['boolean', 'Checkbox'],
  ['date', 'Date'],
  ['select', 'Select'],
  ['multiselect', 'Multi-select'],
  ['document', 'Document'],
  ['json', 'JSON'],
] as const

const SAMPLE_ROWS = 8

export function CsvImportModal({
  tables,
  defaultTableId,
  preview: runPreview,
  onImport,
  onClose,
}: {
  /** Existing tables, offered as append destinations. */
  tables: CsvImportTarget[]
  /** Preselect a destination (opened from a table's own menu). */
  defaultTableId?: string
  /** Dry run: returns the inferred/effective columns, a sample, and failures. */
  /** Dry run. Async because the worker-backed workspace answers it over a
   *  port; the in-tab one resolves immediately. */
  preview: (
    tableId: string,
    csv: string,
    overrides: CsvPreviewColumn[],
  ) => CsvPreview | Promise<CsvPreview>
  onImport: (
    tableId: string,
    tableName: string,
    csv: string,
    columns: CsvPreviewColumn[],
  ) => Promise<{ rowsWritten: number; issues: CsvIssue[] }>
  onClose: () => void
}) {
  const [csv, setCsv] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [mode, setMode] = useState<'new' | 'existing'>(defaultTableId ? 'existing' : 'new')
  const [tableId, setTableId] = useState(defaultTableId ?? tables[0]?.id ?? '')
  const [newName, setNewName] = useState('')
  const [overrides, setOverrides] = useState<CsvPreviewColumn[]>([])
  const [preview, setPreview] = useState<CsvPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ rowsWritten: number; issues: CsvIssue[] } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const destinationId = mode === 'existing' ? tableId : slugify(newName || fileName)
  const destinationName = mode === 'existing'
    ? (tables.find(t => t.id === tableId)?.name ?? tableId)
    : newName || stripExtension(fileName)

  // Re-run the dry run whenever anything it depends on changes: the file, the
  // destination (whose live columns override inference), or a type the user
  // picked. Cheap — it's local, and it keeps the failure count honest.
  useEffect(() => {
    if (!csv) return
    // A stale run must not overwrite a newer one: the user can change the
    // destination or a column type while a previous dry run is still in flight.
    let current = true
    ;(async () => {
      try {
        const result = await runPreview(destinationId, csv, overrides)
        if (!current) return
        setPreview(result)
        setError(null)
      } catch (err) {
        if (!current) return
        setError(err instanceof Error ? err.message : String(err))
        setPreview(null)
      }
    })()
    return () => {
      current = false
    }
  }, [csv, destinationId, overrides, runPreview])

  const readFile = useCallback((file: File) => {
    setFileName(file.name)
    setDone(null)
    const reader = new FileReader()
    reader.onerror = () => setError('Could not read that file')
    reader.onload = () => {
      setCsv(String(reader.result ?? ''))
      // A new file invalidates the previous file's type choices.
      setOverrides([])
    }
    reader.readAsText(file)
  }, [])

  const setType = (name: string, type: string) => {
    const base = preview?.columns.find(c => c.name === name)
    if (!base) return
    setOverrides(prev => [
      ...prev.filter(c => c.name !== name),
      // Options belong to the old type; dropping them lets a re-inferred
      // select rebuild them rather than inheriting a stale list.
      { ...base, type, options: type === base.type ? base.options : null },
    ])
  }

  const canImport =
    !!csv && !!preview && !busy && destinationId.length > 0 && (mode === 'existing' || !!destinationName)

  const confirm = async () => {
    if (!csv || !preview) return
    setBusy(true)
    setError(null)
    try {
      setDone(await onImport(destinationId, destinationName, csv, preview.columns))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const issueSummary = useMemo(() => summarize(preview?.issues ?? []), [preview])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal csvim"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Import CSV"
      >
        <h2 className="csvim__title">Import CSV</h2>

        {done ? (
          <div className="csvim__done">
            <p>
              Imported <strong>{done.rowsWritten}</strong>{' '}
              {done.rowsWritten === 1 ? 'row' : 'rows'} into “{destinationName}”.
            </p>
            {done.issues.length > 0 && (
              <p className="csvim__warn">
                {done.issues.length} {done.issues.length === 1 ? 'value' : 'values'} could not be
                applied and were left empty.
              </p>
            )}
            <div className="csvim__actions">
              <button type="button" className="csvim__btn csvim__btn--primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="csvim__file">
              <input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv"
                aria-label="CSV file"
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) readFile(file)
                }}
              />
              {fileName && <span className="csvim__filename">{fileName}</span>}
            </div>

            <fieldset className="csvim__dest">
              <legend>Destination</legend>
              <label className="csvim__radio">
                <input
                  type="radio"
                  checked={mode === 'new'}
                  onChange={() => setMode('new')}
                />
                New table
              </label>
              <input
                className="csvim__input"
                placeholder={stripExtension(fileName) || 'Table name'}
                value={newName}
                aria-label="New table name"
                disabled={mode !== 'new'}
                onChange={e => setNewName(e.target.value)}
              />
              <label className="csvim__radio">
                <input
                  type="radio"
                  checked={mode === 'existing'}
                  disabled={tables.length === 0}
                  onChange={() => setMode('existing')}
                />
                Add to
              </label>
              <select
                className="csvim__input"
                aria-label="Destination table"
                value={tableId}
                disabled={mode !== 'existing' || tables.length === 0}
                onChange={e => setTableId(e.target.value)}
              >
                {tables.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </fieldset>

            {preview && (
              <>
                <div className="csvim__previewwrap">
                  <table className="csvim__preview">
                    <thead>
                      <tr>
                        {preview.columns.map(c => (
                          <th key={c.name}>
                            <div className="csvim__colname">{c.name}</div>
                            {c.existing ? (
                              <div className="csvim__locked" title="Matched a column already in this table">
                                {label(c.type)} · existing
                              </div>
                            ) : (
                              <select
                                className="csvim__type"
                                aria-label={`Type for ${c.name}`}
                                value={c.type}
                                onChange={e => setType(c.name, e.target.value)}
                              >
                                {CHOOSABLE_TYPES.map(([value, text]) => (
                                  <option key={value} value={value}>
                                    {text}
                                  </option>
                                ))}
                              </select>
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r, i) => (
                        <tr key={i}>
                          {r.map((v, j) => (
                            <td key={j}>{v}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="csvim__count">
                  {preview.totalRows} {preview.totalRows === 1 ? 'row' : 'rows'}
                  {preview.rows.length < preview.totalRows &&
                    ` (showing the first ${Math.min(SAMPLE_ROWS, preview.rows.length)})`}
                </p>

                {issueSummary.length > 0 && (
                  <div className="csvim__issues" role="alert">
                    <strong>
                      {preview.issues.length}{' '}
                      {preview.issues.length === 1 ? 'value' : 'values'} won’t import:
                    </strong>
                    <ul>
                      {issueSummary.map(s => (
                        <li key={s.key}>
                          {s.column}: {s.message}
                          {s.count > 1 && ` (×${s.count})`}
                        </li>
                      ))}
                    </ul>
                    <span className="csvim__hint">
                      Change the column’s type above, or import anyway — these cells will be left
                      empty.
                    </span>
                  </div>
                )}
              </>
            )}

            {error && (
              <p className="csvim__error" role="alert">
                {error}
              </p>
            )}

            <div className="csvim__actions">
              <button type="button" className="csvim__btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="csvim__btn csvim__btn--primary"
                onClick={confirm}
                disabled={!canImport}
              >
                {busy ? 'Importing…' : 'Import'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Collapse per-cell failures into one line per (column, reason) — a 500-row
 *  CSV with one bad column should read as one problem, not 500. */
function summarize(issues: CsvIssue[]) {
  const byKey = new Map<string, { key: string; column: string; message: string; count: number }>()
  for (const i of issues) {
    const key = `${i.column} ${i.message}`
    const hit = byKey.get(key)
    if (hit) hit.count += 1
    else byKey.set(key, { key, column: i.column, message: i.message, count: 1 })
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, 5)
}

function label(type: string) {
  return CHOOSABLE_TYPES.find(([v]) => v === type)?.[1] ?? type
}

function stripExtension(name: string) {
  return name.replace(/\.[^.]+$/, '')
}

function slugify(name: string) {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return s || 'imported'
}
