/**
 * Resolving the rows of a referenced table to `{ id, label }` pairs — what a
 * `reference` / `multireference` cell shows instead of a raw row id.
 *
 * Which column supplies the label is an explicit setting on the referencing
 * column (`reference_display_column`), materialized when the column is created
 * rather than inferred at read time. The first-text-column fallback below
 * exists only for columns created before that setting did. Eventually the
 * setting becomes a Typst formula over the row (issue 25e5e91a); the shape of
 * this function — row in, string out — is chosen to survive that.
 */

/** A referenced row, ready to display or pick from. */
export interface ReferenceRecord {
  id: string
  label: string
}

/** Resolve a referenced table's rows. `displayColumn` is the referencing
 *  column's `reference_display_column`. */
export type ReferenceLookup = (tableId: string, displayColumn?: string) => ReferenceRecord[]

interface WorkspaceLike {
  getTableRows(tableId: string): string
  getTableSchema(tableId: string): string
}

/** Build a lookup bound to a workspace handle. Returns `[]` for an unknown or
 *  unreadable table, so a dangling `reference_table` degrades to raw ids
 *  instead of throwing. */
export function makeReferenceLookup(workspace: WorkspaceLike | null): ReferenceLookup {
  return (tableId: string, displayColumn?: string) => {
    if (!workspace) return []
    let rows: Array<Record<string, unknown>>
    try {
      rows = JSON.parse(workspace.getTableRows(tableId))
    } catch {
      return []
    }
    let labelColId = displayColumn
    if (!labelColId) {
      // Legacy columns (no explicit setting): the first text column.
      try {
        const schema = JSON.parse(workspace.getTableSchema(tableId))
        labelColId = (Object.values(schema.columns ?? {}) as Array<{ id: string; column_type: string }>)
          .find(c => c.column_type === 'text')?.id
      } catch {
        /* no schema — fall back to the row id */
      }
    }
    return rows.map(r => {
      const id = String(r._row_id)
      const raw = labelColId ? r[labelColId] : undefined
      const label = raw == null || raw === '' ? id : String(raw)
      return { id, label }
    })
  }
}

/**
 * The label for one referenced id. A referenced row that no longer exists is
 * "dangling": we show its raw id rather than a blank cell, so the broken link
 * is visible and fixable instead of silently swallowed.
 */
export function referenceLabel(records: ReferenceRecord[] | null, id: string): {
  label: string
  dangling: boolean
} {
  const hit = records?.find(r => r.id === id)
  return hit ? { label: hit.label, dangling: false } : { label: id, dangling: true }
}
