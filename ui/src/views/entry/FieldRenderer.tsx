import { CellEditor, type CellColumn } from '@/cells/cellRegistry'
import './FieldRenderer.css'

interface FieldRendererProps {
  column: CellColumn
  value: any
  onChange: (value: any) => void
}

/**
 * Entry/detail-view field: a labelled, always-editable cell.
 *
 * The per-type editing logic lives in the shared cell registry
 * (`ui/src/cells/cellRegistry.tsx`), so the table grid and this view use the
 * exact same editors (commit on blur/Enter) — no more duplicated per-type
 * `<input>` handling. This component only adds the entry-view label/layout.
 */
export function FieldRenderer({ column, value, onChange }: FieldRendererProps) {
  return (
    <div className="field-renderer">
      {column.column_type !== 'boolean' && (
        <label className="field-label">
          {column.name}
          {column.required && <span className="required-indicator">*</span>}
        </label>
      )}
      <CellEditor column={column} value={value} commit={onChange} />
    </div>
  )
}
